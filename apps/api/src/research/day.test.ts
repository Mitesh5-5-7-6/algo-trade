import { beforeAll, describe, expect, it } from "vitest";
import { istDateKey, type Candle } from "@neelkanth/core";
import { goldenBudget, historicalBars } from "../replay/test-support.js";
import { DEFAULT_REGIME_MODEL } from "../counterfactual/regime.js";
import {
  runDay,
  sessionsEndingAt,
  type DayRun,
  type DayRunRequest,
} from "./day.js";

/**
 * Task 8.1 (design D1): a day's report is the run over the K sessions ending
 * on it, reported for that day alone — so it depends on neither later bars
 * nor the range a batch happened to load.
 */
const SYM = "NSE:TESTCO-EQ";
const INDEX = "NSE:TESTINDEX-INDEX";
// Weekdays from Mon 2026-01-05: two weeks, the weekend skipped; days differ.
const WEEKDAYS = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
let candles: Candle[];
beforeAll(async () => {
  candles = await historicalBars(
    WEEKDAYS,
    (d) => 1 + (d % 5) * 0.04 + d * 0.01,
  );
}, 120_000);

const request = (over: Partial<DayRunRequest> = {}): DayRunRequest => ({
  date: "2026-01-14",
  candles,
  symbols: [SYM],
  hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
  ...goldenBudget(),
  seed: 0,
  regime: { ...DEFAULT_REGIME_MODEL, symbol: INDEX },
  ...over,
});
const essence = (d: DayRun) => ({
  sessions: d.sessions,
  occurrences: d.occurrences,
  attributions: d.attributions,
  strategyDays: d.strategyDays,
});

describe("a day's run (8.1, D1)", () => {
  it("reads the K trading sessions ending at the day — weekends are not sessions", async () => {
    expect(sessionsEndingAt(candles, "2026-01-14", 5)).toEqual([
      "2026-01-08",
      "2026-01-09",
      "2026-01-12",
      "2026-01-13",
      "2026-01-14",
    ]);
    const day = await runDay(request());
    expect(new Set(day.bars.map((b) => istDateKey(b.ts)))).toEqual(
      new Set(day.sessions),
    );
  }, 120_000);

  it("reports the day alone", async () => {
    const day = await runDay(request());
    expect(day.occurrences.length).toBeGreaterThan(0);
    expect(
      day.occurrences.every((o) => istDateKey(o.ts) === "2026-01-14"),
    ).toBe(true);
    expect(
      day.attributions.every((a) => istDateKey(a.ts) === "2026-01-14"),
    ).toBe(true);
    for (const s of day.strategyDays) {
      expect(
        s.trades.every(
          (t) => istDateKey(t.dataProvenance?.barTs ?? 0) === "2026-01-14",
        ),
      ).toBe(true);
      expect(
        s.signals.every(
          (x) => istDateKey(x.dataProvenance?.barTs ?? x.ts) === "2026-01-14",
        ),
      ).toBe(true);
    }
    // A fair test: strategies did trade that day.
    expect(
      day.strategyDays.reduce((n, s) => n + s.trades.length, 0),
    ).toBeGreaterThan(0);
  }, 120_000);

  /** §5.4: what happens after the day cannot change its report. */
  it("does not depend on bars after the day", async () => {
    const through = candles.filter((c) => istDateKey(c.ts) <= "2026-01-14");
    expect(essence(await runDay(request({ candles: through })))).toEqual(
      essence(await runDay(request())),
    );
  }, 120_000);

  /** Produced by a year-long batch or alone, the same report. */
  it("does not depend on where the loaded range begins", async () => {
    const late = candles.filter((c) => istDateKey(c.ts) >= "2026-01-08");
    expect(essence(await runDay(request({ candles: late })))).toEqual(
      essence(await runDay(request())),
    );
  }, 120_000);

  /** And the lookback is real: a different K is a different, declared, run. */
  it("depends on its declared lookback", async () => {
    const one = await runDay(request({ lookbackSessions: 1 }));
    expect(one.sessions).toEqual(["2026-01-14"]);
    expect(essence(one)).not.toEqual(essence(await runDay(request())));
  }, 120_000);

  it("refuses a day the bars hold no session on, and a nonsense lookback", async () => {
    await expect(runDay(request({ date: "2026-01-10" }))).rejects.toThrow(
      /no session on 2026-01-10/,
    );
    await expect(runDay(request({ lookbackSessions: 0 }))).rejects.toThrow(
      /positive integer/,
    );
  }, 120_000);
});
