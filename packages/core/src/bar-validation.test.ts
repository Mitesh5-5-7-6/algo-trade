import { describe, expect, it } from "vitest";
import {
  summarizeRejections,
  validateBar,
  validateBars,
  type BarValidationOptions,
  type RawBar,
} from "./bar-validation.js";

/**
 * §5 of the Phase 1 design, task 1.7.
 *
 * The point of these checks is not that the numbers are wrong — it is that a
 * wrong bar written to storage is indistinguishable from a right one forever
 * after. Every assertion below is about something that would otherwise be
 * discovered months later as a strategy behaving oddly on one week in March.
 */

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
/** Epoch ms for an IST wall-clock instant (month is 0-based). */
const ist = (y: number, mo: number, d: number, h: number, mi: number): number =>
  Date.UTC(y, mo, d, h, mi) - IST_OFFSET_MS;

// 2026-01-05 is a Monday. 09:15 IST is the session open.
const OPEN = ist(2026, 0, 5, 9, 15);

const options: BarValidationOptions = { interval: "5m" };

const bar = (fields: Partial<RawBar> = {}): RawBar => ({
  ts: OPEN,
  open: 100,
  high: 101,
  low: 99,
  close: 100.5,
  volume: 1_000,
  ...fields,
});

describe("validateBar — arithmetic that cannot be true of a real bar", () => {
  it("accepts a sound bar", () => {
    expect(validateBar(bar(), options)).toBeNull();
  });

  it("accepts a bar with zero volume", () => {
    // Index bars may legitimately carry no volume (Q4 is unanswered); zero is
    // not corruption, and rejecting it would throw away every index bar.
    expect(validateBar(bar({ volume: 0 }), options)).toBeNull();
  });

  it("accepts a flat bar where every price is equal", () => {
    const flat = bar({ open: 100, high: 100, low: 100, close: 100 });
    expect(validateBar(flat, options)).toBeNull();
  });

  it("rejects high below low", () => {
    const rejection = validateBar(bar({ high: 98, low: 99 }), options);
    expect(rejection?.code).toBe("high-below-low");
  });

  it("rejects a range that does not contain the open", () => {
    const rejection = validateBar(bar({ open: 105 }), options);
    expect(rejection?.code).toBe("ohlc-inconsistent");
  });

  it("rejects a range that does not contain the close", () => {
    const rejection = validateBar(bar({ close: 95 }), options);
    expect(rejection?.code).toBe("ohlc-inconsistent");
  });

  it.each(["open", "high", "low", "close"] as const)(
    "rejects a non-positive %s",
    (field) => {
      const rejection = validateBar(bar({ [field]: 0 }), options);
      expect(rejection?.code).toBe("price-not-positive");
      expect(rejection?.reason).toContain(field);
    },
  );

  it("rejects a negative price", () => {
    expect(validateBar(bar({ low: -1 }), options)?.code).toBe(
      "price-not-positive",
    );
  });

  it("rejects negative volume", () => {
    expect(validateBar(bar({ volume: -1 }), options)?.code).toBe(
      "volume-negative",
    );
  });

  /**
   * NaN survives every `<` and `>` below by returning false, so without an
   * explicit finiteness check a mangled row would pass all of them and be
   * stored. `Number(null)` is 0, but `Number(undefined)` and `Number("n/a")`
   * are NaN — both are plausible things to find in a vendor response.
   */
  it.each(["open", "high", "low", "close", "volume", "ts"] as const)(
    "rejects a NaN %s rather than letting it pass every comparison",
    (field) => {
      const rejection = validateBar(bar({ [field]: Number.NaN }), options);
      expect(rejection?.code).toBe("non-finite");
      expect(rejection?.reason).toContain(field);
    },
  );

  it("rejects an infinite price", () => {
    expect(
      validateBar(bar({ high: Number.POSITIVE_INFINITY }), options)?.code,
    ).toBe("non-finite");
  });
});

describe("validateBar — timestamps that could not have been a session", () => {
  it("rejects a ts that is not on an interval boundary", () => {
    // 09:17 is not a 5m bucket start; live aggregation could never emit it.
    const rejection = validateBar(bar({ ts: ist(2026, 0, 5, 9, 17) }), options);
    expect(rejection?.code).toBe("ts-not-aligned");
  });

  it("accepts every 5m boundary across the session", () => {
    // 09:15 through 15:25 inclusive is 75 buckets — a full NSE session.
    const accepted: number[] = [];
    for (let minute = 9 * 60 + 15; minute < 15 * 60 + 30; minute += 5) {
      const ts = ist(2026, 0, 5, Math.floor(minute / 60), minute % 60);
      if (validateBar(bar({ ts }), options) === null) accepted.push(ts);
    }
    expect(accepted).toHaveLength(75);
  });

  it("rejects a bar before the open", () => {
    // 09:10 IST is pre-open auction, not continuous trading.
    const rejection = validateBar(bar({ ts: ist(2026, 0, 5, 9, 10) }), options);
    expect(rejection?.code).toBe("ts-outside-session");
  });

  /**
   * `ts` is the bucket START, so a 5m bar stamped 15:30 would cover
   * 15:30–15:35 — the exchange was shut for all of it. The last valid bar of
   * the day starts at 15:25.
   */
  it("rejects a bar starting exactly at the close, and accepts the one before", () => {
    expect(
      validateBar(bar({ ts: ist(2026, 0, 5, 15, 30) }), options)?.code,
    ).toBe("ts-outside-session");
    expect(
      validateBar(bar({ ts: ist(2026, 0, 5, 15, 25) }), options),
    ).toBeNull();
  });

  it("rejects a bar on a Saturday", () => {
    // 2026-01-03 is a Saturday, at a time that would be valid on a weekday.
    const rejection = validateBar(bar({ ts: ist(2026, 0, 3, 10, 0) }), options);
    expect(rejection?.code).toBe("ts-non-trading-day");
  });

  it("rejects a bar on a declared exchange holiday", () => {
    const rejection = validateBar(bar({ ts: ist(2026, 0, 5, 10, 0) }), {
      ...options,
      holidays: new Set(["2026-01-05"]),
    });
    expect(rejection?.code).toBe("ts-non-trading-day");
    expect(rejection?.reason).toContain("2026-01-05");
  });

  /**
   * The holiday list is a parameter rather than a constant precisely so
   * ingestion reads the same global settings the live session does. A bar that
   * is fine with no holiday list must become a rejection once the day is
   * declared — otherwise the two could disagree about whether a day existed.
   */
  it("accepts the same bar when the day is not declared a holiday", () => {
    const ts = ist(2026, 0, 5, 10, 0);
    expect(validateBar(bar({ ts }), options)).toBeNull();
    expect(
      validateBar(bar({ ts }), {
        ...options,
        holidays: new Set(["2026-01-06"]),
      }),
    ).toBeNull();
  });

  it("honours a non-default session window", () => {
    const ts = ist(2026, 0, 5, 9, 5);
    expect(validateBar(bar({ ts }), options)?.code).toBe("ts-outside-session");
    expect(
      validateBar(bar({ ts }), {
        ...options,
        session: {
          preOpen: "08:45",
          open: "09:00",
          close: "15:30",
          holidays: [],
          exchange: "TEST",
        },
      }),
    ).toBeNull();
  });

  it("uses the interval's own width, so a 15m bar at 09:20 is unaligned", () => {
    const ts = ist(2026, 0, 5, 9, 20);
    expect(validateBar(bar({ ts }), { interval: "5m" })).toBeNull();
    expect(validateBar(bar({ ts }), { interval: "15m" })?.code).toBe(
      "ts-not-aligned",
    );
  });

  /**
   * The bar is judged by the IST date its timestamp falls in, not the UTC one.
   * 2026-01-02 20:00 UTC is 2026-01-03 01:30 IST — a Saturday — and a
   * validator working in UTC would call it a Friday and wave it through.
   */
  it("judges the trading day in IST, not UTC", () => {
    const rejection = validateBar(
      bar({ ts: Date.UTC(2026, 0, 2, 20, 0) }),
      options,
    );
    expect(rejection?.code).toBe("ts-non-trading-day");
    expect(rejection?.reason).toContain("2026-01-03");
  });
});

describe("validateBar — reporting the most fundamental failure", () => {
  /**
   * A bar can fail several checks at once. Reporting all of them turns one
   * cause into four symptoms, and the run summary then groups by the noise.
   */
  it("reports the mangled arithmetic, not the timestamp, when both are wrong", () => {
    const rejection = validateBar(
      bar({ high: 1, low: 99, ts: ist(2026, 0, 3, 9, 17) }),
      options,
    );
    expect(rejection?.code).toBe("high-below-low");
  });

  it("names the offending values so the report is actionable", () => {
    const rejection = validateBar(bar({ high: 98, low: 99 }), options);
    expect(rejection?.reason).toContain("98");
    expect(rejection?.reason).toContain("99");
  });
});

describe("validateBars — properties only visible across a batch", () => {
  const at = (h: number, mi: number, fields: Partial<RawBar> = {}): RawBar =>
    bar({ ts: ist(2026, 0, 5, h, mi), ...fields });

  it("keeps sound bars and sets aside the rest, with the reason attached", () => {
    const result = validateBars(
      [at(9, 15), at(9, 20, { high: 1, low: 99 }), at(9, 25)],
      options,
    );
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.rejection.code).toBe("high-below-low");
    expect(result.rejected[0]?.bar.ts).toBe(ist(2026, 0, 5, 9, 20));
  });

  it("drops a repeated ts, first occurrence winning", () => {
    const first = at(9, 15, { close: 100 });
    const repeat = at(9, 15, { close: 100.75 });
    const result = validateBars([first, repeat, at(9, 20)], options);

    expect(result.accepted).toHaveLength(2);
    expect(result.accepted[0]?.close).toBe(100);
    expect(result.duplicates).toEqual([repeat]);
  });

  /**
   * A rejected bar must not reserve its bucket. If it did, one mangled row
   * would suppress the good bar that followed it and the gap would be recorded
   * as a duplicate rather than as the rejection it was.
   */
  it("lets a sound bar claim a bucket an invalid bar also carried", () => {
    const broken = at(9, 15, { high: 1, low: 99 });
    const good = at(9, 15, { close: 100.25 });
    const result = validateBars([broken, good], options);

    expect(result.accepted).toEqual([good]);
    expect(result.duplicates).toEqual([]);
    expect(result.rejected).toHaveLength(1);
  });

  /**
   * Newest-first is a normal vendor convention, not corruption — so it is
   * reported rather than rejected. What must not happen is a caller assuming
   * the last element is the latest bar and paging from the wrong end.
   */
  it("reports descending order without discarding the bars", () => {
    const result = validateBars([at(9, 25), at(9, 20), at(9, 15)], options);
    expect(result.outOfOrder).toBe(true);
    expect(result.accepted).toHaveLength(3);
  });

  it("does not flag ascending order", () => {
    const result = validateBars([at(9, 15), at(9, 20), at(9, 25)], options);
    expect(result.outOfOrder).toBe(false);
  });

  it("does not flag a repeated ts as out of order", () => {
    const result = validateBars([at(9, 15), at(9, 15)], options);
    expect(result.outOfOrder).toBe(false);
    expect(result.duplicates).toHaveLength(1);
  });

  it("handles an empty batch", () => {
    const result = validateBars([], options);
    expect(result).toEqual({
      accepted: [],
      rejected: [],
      duplicates: [],
      outOfOrder: false,
    });
  });

  it("preserves the caller's own bar type", () => {
    const tagged = { ...at(9, 15), page: 3 };
    const result = validateBars([tagged], options);
    expect(result.accepted[0]?.page).toBe(3);
  });
});

describe("summarizeRejections — a result, not a log line", () => {
  it("groups by code, most frequent first, with examples", () => {
    const at = (h: number, mi: number, fields: Partial<RawBar>): RawBar =>
      bar({ ts: ist(2026, 0, 5, h, mi), ...fields });
    const result = validateBars(
      [
        at(9, 15, { volume: -1 }),
        at(9, 20, { high: 1, low: 99 }),
        at(9, 25, { high: 1, low: 99 }),
        at(9, 30, { high: 1, low: 99 }),
      ],
      options,
    );

    const summary = summarizeRejections(result.rejected);
    expect(summary).toHaveLength(2);
    expect(summary[0]?.code).toBe("high-below-low");
    expect(summary[0]?.count).toBe(3);
    expect(summary[0]?.examples).toHaveLength(3);
    expect(summary[1]?.code).toBe("volume-negative");
  });

  it("caps the examples it keeps", () => {
    const rejected = Array.from({ length: 50 }, () => ({
      rejection: { code: "volume-negative" as const, reason: "volume is -1" },
    }));
    const summary = summarizeRejections(rejected, 2);
    expect(summary[0]?.count).toBe(50);
    expect(summary[0]?.examples).toHaveLength(2);
  });

  it("returns nothing when a run rejected nothing", () => {
    expect(summarizeRejections([])).toEqual([]);
  });
});

describe("volume is optional, because an index has none of its own", () => {
  /**
   * ARCHITECTURE_DECISION §20: volume is not meaningful for every
   * instrument. An NSE index has no tradeable volume, so a source that
   * omits it is telling us something true. Rejecting the bar would discard
   * a sound OHLC record over a field the instrument never had — and
   * rejecting every index bar is a data outage, not a validation rule.
   */
  it("accepts a bar with no volume at all", () => {
    expect(validateBar(bar({ volume: null }), options)).toBeNull();
  });

  it("still accepts a real zero", () => {
    expect(validateBar(bar({ volume: 0 }), options)).toBeNull();
  });

  /** Optional is not unchecked. */
  it("still rejects a negative volume", () => {
    expect(validateBar(bar({ volume: -1 }), options)?.code).toBe(
      "volume-negative",
    );
  });

  /**
   * `null` is a statement; NaN is a defect. `Number("n/a")` produces NaN,
   * and it would survive `volume < 0` by returning false.
   */
  it("rejects a NaN volume while accepting a null one", () => {
    expect(validateBar(bar({ volume: Number.NaN }), options)?.code).toBe(
      "non-finite",
    );
    expect(validateBar(bar({ volume: null }), options)).toBeNull();
  });

  it("does not let a missing volume mask a bad price", () => {
    const rejection = validateBar(
      bar({ volume: null, high: 1, low: 99 }),
      options,
    );
    expect(rejection?.code).toBe("high-below-low");
  });
});
