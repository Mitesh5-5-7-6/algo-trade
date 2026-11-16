import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_SETTINGS } from "@neelkanth/db";
import { OddsRefusal } from "./refusal.js";
import { runSetupOdds, type SetupOddsRequest } from "./run.js";
import { orbDay, ORB_DAY_SYMBOL, type OrbDayKind } from "./test-support.js";

/** Eight sessions before the plan's Monday: what ORB did on each. */
const SESSIONS: [string, OrbDayKind][] = [
  ["2026-03-02", "TARGET"],
  ["2026-03-03", "STOP"],
  ["2026-03-04", "NEITHER"],
  ["2026-03-05", "QUIET"],
  ["2026-03-06", "TARGET"],
  ["2026-03-09", "STOP"],
  ["2026-03-10", "TARGET"],
  ["2026-03-11", "QUIET"],
];
const CANDLES = SESSIONS.flatMap(([date, kind]) => orbDay(date, kind));

/** Long from 20,080 at 09:40: stop 80 below, target 100 above — 1.25R. */
const request = (over: Partial<SetupOddsRequest> = {}): SetupOddsRequest => ({
  plan: {
    symbol: ORB_DAY_SYMBOL,
    side: "LONG",
    entry: 20_080,
    stop: 20_000,
    target: 20_180,
    date: "2026-03-16",
    time: "09:40",
  },
  candles: CANDLES,
  resampling: { replays: 400, seed: 7, window: 0 },
  hours: DEFAULT_GLOBAL_SETTINGS.marketHours,
  allocatedCapital: 1_000_000,
  limits: DEFAULT_GLOBAL_SETTINGS.globalRiskLimits,
  ...over,
});
const ORB = { type: "ORB", params: {} };

describe("one setup-odds run (17.6)", () => {
  it("reports the resampled odds and the rule's history side by side, each judged", async () => {
    const { manifest, result } = await runSetupOdds(request({ rule: ORB }));

    expect(manifest.plan).toMatchObject({ entryBar: 4, targetR: 1.25 });
    expect(manifest.pool).toMatchObject({
      barsPerSession: 75,
      sessions: 8,
      dates: SESSIONS.map(([date]) => date),
      excluded: [],
    });

    const r = result.resampled;
    expect(r.targetFirst + r.stopFirst + r.neither).toBe(400);
    // The one moving bar after 09:40 reaches the target in three sessions of
    // eight and the stop in two: both happen, the target more often.
    expect(r.targetFirst).toBeGreaterThan(r.stopFirst);
    expect(r.stopFirst).toBeGreaterThan(0);
    expect(result.resampledVerdict.decided).toBe(r.targetFirst + r.stopFirst);

    // ORB went long on six of the eight days: three targets, two stops, one
    // neither — five decided, far short of a verdict.
    expect(result.history).toMatchObject({
      sessions: 8,
      fired: 6,
      targetFirst: 3,
      stopFirst: 2,
      neither: 1,
    });
    expect(result.historyVerdict).toMatchObject({
      fired: 6,
      decided: 5,
      verdict: "INSUFFICIENT_SAMPLE",
    });
    expect(manifest.history?.rule).toMatchObject({ type: "ORB", params: {} });
  });

  it("runs no history when the plan names no rule, and says so", async () => {
    const { manifest, result } = await runSetupOdds(request());
    expect(manifest.history).toBeNull();
    expect(result.history).toBeNull();
    expect(result.historyVerdict).toBeNull();
  });

  it("gives the same fingerprint for the same request, and another for another seed", async () => {
    const a = await runSetupOdds(request({ rule: ORB }));
    const b = await runSetupOdds(request({ rule: ORB }));
    expect(b).toEqual(a);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const other = await runSetupOdds(
      request({ rule: ORB, resampling: { replays: 400, seed: 8, window: 0 } }),
    );
    expect(other.fingerprint).not.toBe(a.fingerprint);
  });

  it("is blind to the plan's own day and every day after it", async () => {
    const before = await runSetupOdds(request({ rule: ORB }));
    // The plan's day ends at its stop and the next at its target: neither
    // may reach the pool, the history, or the fingerprint.
    const after = await runSetupOdds(
      request({
        rule: ORB,
        candles: [
          ...CANDLES,
          ...orbDay("2026-03-16", "STOP"),
          ...orbDay("2026-03-17", "TARGET"),
        ],
      }),
    );
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.manifest.pool.dates).not.toContain("2026-03-16");
  });

  it("places the plan on the last bar that had closed by its time", async () => {
    const entryBar = async (time: string) =>
      (await runSetupOdds(request({ plan: { ...request().plan, time } })))
        .manifest.plan.entryBar;
    expect(await entryBar("09:20")).toBe(0);
    expect(await entryBar("10:05")).toBe(9);
    expect(await entryBar("10:07")).toBe(9);
    expect(await entryBar("15:25")).toBe(73);
  });

  it("refuses a time before the first bar closes, or with nothing left to replay", async () => {
    const at = (time: string) =>
      runSetupOdds(request({ plan: { ...request().plan, time } }));
    await expect(at("09:19")).rejects.toThrow(/before the first bar/);
    await expect(at("15:30")).rejects.toThrow(/nothing left to replay/);
  });

  it("refuses, as the plan's fault, what it cannot compute odds for", async () => {
    const refused = async (over: Partial<SetupOddsRequest>) =>
      runSetupOdds(request(over)).catch((error: unknown) => error);
    const plan = request().plan;

    for (const [over, words] of [
      [{ plan: { ...plan, stop: 20_100 } }, /stop must be below/],
      [{ plan: { ...plan, time: "09:19" } }, /before the first bar/],
      [{ plan: { ...plan, date: "2026-03-02" } }, /no full session/],
      [{ rule: { type: "NO_SUCH_RULE", params: {} } }, /NO_SUCH_RULE/],
      [
        { rule: { type: "ORB", params: { rangeMinutes: -5 } } },
        /the rule ORB cannot be used/,
      ],
      [
        { rule: { type: "ORB", params: { interval: "15m" } } },
        /decides on 15m bars, but the dataset is 5m/,
      ],
    ] as const) {
      const error = await refused(over);
      expect(error).toBeInstanceOf(OddsRefusal);
      expect((error as Error).message).toMatch(words);
    }
  });

  it("draws from the most recent sessions only, when told how many", async () => {
    const { manifest, result } = await runSetupOdds(
      request({ rule: ORB, lookbackSessions: 3 }),
    );
    expect(manifest.pool).toMatchObject({
      lookbackSessions: 3,
      sessions: 3,
      dates: ["2026-03-09", "2026-03-10", "2026-03-11"],
    });
    // The history covers the same days as the pool, no more.
    expect(result.history).toMatchObject({ sessions: 3, fired: 2 });
  });

  it("lists a session it left out, and what the pool was made of", async () => {
    const short = orbDay("2026-03-12", "TARGET").slice(0, 60);
    const { manifest } = await runSetupOdds(
      request({ candles: [...CANDLES, ...short] }),
    );
    expect(manifest.pool.excluded).toEqual([
      { date: "2026-03-12", reason: "INCOMPLETE", bars: 60 },
    ]);
    expect(manifest.pool.sessions).toBe(8);
    expect(manifest.pool.sources).toEqual({ BROKER_HISTORICAL: 600 });
    expect(manifest.pool.ingestionVersions).toEqual([1]);
  });

  it("refuses when the symbol has no full session before the plan's date", async () => {
    await expect(
      runSetupOdds(
        request({ plan: { ...request().plan, date: "2026-03-02" } }),
      ),
    ).rejects.toThrow(/no full session of NSE:NIFTY50-INDEX before 2026-03-02/);
  });
});
