import { describe, expect, it } from "vitest";
import {
  isTradingDayIST,
  istDateKey,
  startOfDayIST,
  tradingDaysBetween,
} from "./calendar.js";

/** Epoch ms for an IST wall-clock instant (month is 0-based). */
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const ist = (y: number, mo: number, d: number, h: number, mi: number): number =>
  Date.UTC(y, mo, d, h, mi) - IST_OFFSET_MS;

// 2026-01-05 is a Monday; -03 Sat, -04 Sun.
const MON = [2026, 0, 5] as const;

describe("istDateKey", () => {
  it("returns the IST trading date, not the UTC date", () => {
    // 2026-01-05 20:00 UTC = 2026-01-06 01:30 IST → next day in IST.
    expect(istDateKey(Date.UTC(2026, 0, 5, 20, 0))).toBe("2026-01-06");
    expect(istDateKey(ist(...MON, 9, 20))).toBe("2026-01-05");
  });
});

describe("startOfDayIST", () => {
  it("returns IST midnight of the instant's trading date, in epoch ms", () => {
    // Any instant during Monday's IST day maps to Mon 00:00 IST.
    expect(startOfDayIST(ist(...MON, 9, 20))).toBe(ist(...MON, 0, 0));
    expect(startOfDayIST(ist(...MON, 23, 59))).toBe(ist(...MON, 0, 0));
    // 20:00 UTC Mon is already Tuesday 01:30 IST → Tuesday's midnight.
    expect(startOfDayIST(Date.UTC(2026, 0, 5, 20, 0))).toBe(
      ist(2026, 0, 6, 0, 0),
    );
  });

  it("agrees with istDateKey about which day an instant belongs to", () => {
    const around = Date.UTC(2026, 0, 5, 18, 30); // exactly IST midnight
    for (const now of [around - 1, around, around + 1]) {
      expect(istDateKey(startOfDayIST(now))).toBe(istDateKey(now));
    }
  });
});

describe("tradingDaysBetween (research windows are counted in sessions)", () => {
  const NONE: ReadonlySet<string> = new Set();

  it("returns the trading dates in an inclusive range, weekends removed", () => {
    // Mon 2026-01-05 → Sun 2026-01-11.
    const days = tradingDaysBetween(
      ist(2026, 0, 5, 0, 0),
      ist(2026, 0, 11, 23, 59),
      NONE,
    );
    expect(days).toEqual([
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
      "2026-01-09",
    ]);
  });

  it("removes exchange holidays, so a holiday week is four sessions", () => {
    const days = tradingDaysBetween(
      ist(2026, 0, 5, 0, 0),
      ist(2026, 0, 9, 23, 59),
      new Set(["2026-01-07"]),
    );
    expect(days).toHaveLength(4);
    expect(days).not.toContain("2026-01-07");
  });

  /**
   * The distinction the backfill depends on: a day the exchange was shut and a
   * day the fetch failed both return zero candles, and only one is a problem.
   */
  it("omits a closed day entirely rather than reporting it as a gap", () => {
    const saturday = ist(2026, 0, 3, 10, 0);
    expect(tradingDaysBetween(saturday, saturday, NONE)).toEqual([]);
    const holiday = ist(2026, 0, 5, 10, 0);
    expect(
      tradingDaysBetween(holiday, holiday, new Set(["2026-01-05"])),
    ).toEqual([]);
  });

  it("is independent of the time of day the range starts and ends at", () => {
    const fromMidnight = tradingDaysBetween(
      ist(2026, 0, 5, 0, 0),
      ist(2026, 0, 7, 0, 0),
      NONE,
    );
    const fromLateEvening = tradingDaysBetween(
      ist(2026, 0, 5, 23, 59),
      ist(2026, 0, 7, 23, 59),
      NONE,
    );
    expect(fromLateEvening).toEqual(fromMidnight);
    expect(fromMidnight).toHaveLength(3);
  });

  it("includes both ends and handles a single trading day", () => {
    const monday = ist(2026, 0, 5, 12, 0);
    expect(tradingDaysBetween(monday, monday, NONE)).toEqual(["2026-01-05"]);
  });

  it("yields nothing for an inverted range", () => {
    expect(
      tradingDaysBetween(ist(2026, 0, 9, 0, 0), ist(2026, 0, 5, 0, 0), NONE),
    ).toEqual([]);
  });

  it("crosses a month boundary without drifting", () => {
    // Fri 2026-01-30 → Mon 2026-02-02 (31st is a Saturday, 1st a Sunday).
    const days = tradingDaysBetween(
      ist(2026, 0, 30, 0, 0),
      ist(2026, 1, 2, 23, 59),
      NONE,
    );
    expect(days).toEqual(["2026-01-30", "2026-02-02"]);
  });
});

describe("special sessions — a weekend is not conclusive", () => {
  const NONE: ReadonlySet<string> = new Set();

  /**
   * NSE runs special live sessions on weekends: the Union Budget session on
   * 1 February and the Diwali Muhurat session. They are real trading days
   * with real volume.
   *
   * This is not hypothetical. The first one-year backfill rejected 75 genuine
   * bars for Sunday 2026-02-01 — a full Budget-day session — because the
   * weekend rule was treated as absolute. The rejection report is what
   * surfaced it.
   */
  it("counts a weekend date listed as a special session", () => {
    const sunday = ist(2026, 1, 1, 12, 0); // 2026-02-01, a Sunday
    expect(tradingDaysBetween(sunday, sunday, NONE)).toEqual([]);
    expect(
      tradingDaysBetween(sunday, sunday, NONE, new Set(["2026-02-01"])),
    ).toEqual(["2026-02-01"]);
  });

  it("includes it in the middle of an ordinary range", () => {
    // Fri 2026-01-30 .. Mon 2026-02-02, with Sunday the 1st traded.
    const days = tradingDaysBetween(
      ist(2026, 0, 30, 0, 0),
      ist(2026, 1, 2, 23, 59),
      NONE,
      new Set(["2026-02-01"]),
    );
    expect(days).toEqual(["2026-01-30", "2026-02-01", "2026-02-02"]);
  });

  /**
   * A date in both lists is a configuration mistake. Failing closed is the
   * safe direction: a declared closure is a stronger statement than a
   * calendar convention, and treating the day as open would invent bars.
   */
  it("lets an explicit holiday override a special session", () => {
    const sunday = ist(2026, 1, 1, 12, 0);
    expect(
      tradingDaysBetween(
        sunday,
        sunday,
        new Set(["2026-02-01"]),
        new Set(["2026-02-01"]),
      ),
    ).toEqual([]);
  });

  it("does not affect ordinary weekdays or weekends", () => {
    const special = new Set(["2026-02-01"]);
    // Sat 2026-01-31 is still closed.
    expect(
      tradingDaysBetween(
        ist(2026, 0, 31, 0, 0),
        ist(2026, 0, 31, 23, 59),
        NONE,
        special,
      ),
    ).toEqual([]);
    // Mon 2026-01-05 is still open.
    expect(
      tradingDaysBetween(
        ist(2026, 0, 5, 0, 0),
        ist(2026, 0, 5, 23, 59),
        NONE,
        special,
      ),
    ).toEqual(["2026-01-05"]);
  });
});

describe("isTradingDayIST", () => {
  const NONE: ReadonlySet<string> = new Set();

  it.each([
    ["2026-01-05", true, "a Monday"],
    ["2026-01-03", false, "a Saturday"],
    ["2026-01-04", false, "a Sunday"],
  ])("%s -> %s (%s)", (day, expected) => {
    expect(isTradingDayIST(day, NONE)).toBe(expected);
  });

  it("closes a declared holiday that falls on a weekday", () => {
    expect(isTradingDayIST("2026-01-05", new Set(["2026-01-05"]))).toBe(false);
  });

  it("opens a weekend day listed as a special session", () => {
    expect(isTradingDayIST("2026-02-01", NONE, new Set(["2026-02-01"]))).toBe(
      true,
    );
  });
});
