import { describe, expect, it } from "vitest";
import { SignalSchema, TradeSchema } from "@neelkanth/core";
import { runHistoricalReplay } from "./run.js";
import { emaStrategy, goldenBudget, historicalBars } from "./test-support.js";

/**
 * Task 6.1 (Phase 6 design D3): a replay hands out its trail — the complete
 * Signals, risk decisions and Trades — so research can join a decision to the
 * bar it was made on. The record, and so every fingerprint, does not move.
 */
const run = async () =>
  runHistoricalReplay({
    strategy: emaStrategy(),
    candles: await historicalBars([0, 1]),
    hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
    ...goldenBudget(),
    seed: 7,
  });

describe("a replay's trail (6.1, D3)", () => {
  /** Captured at 6e4464a, before the trail existed. */
  it("leaves the record and its fingerprint exactly as they were", async () => {
    const { fingerprint, record } = await run();
    expect(fingerprint).toBe(
      "6a5a3d588bc01a2702967a3605b3f32ae90a1662cb6bbea41f56e6ac28bb76f6",
    );
    expect(record).not.toHaveProperty("trail");
  });

  it("holds every Trade of the record, complete", async () => {
    const { record, trail } = await run();
    expect(trail.trades.map((t) => t.tradeId)).toEqual(
      record.trades.map((t) => t.tradeId),
    );
    for (const trade of trail.trades) {
      const parsed = TradeSchema.parse(trade);
      // What a join to the pattern on the entry bar needs.
      expect(parsed.entryTime).toBeGreaterThan(0);
      expect(parsed.exitTime).toBeGreaterThanOrEqual(parsed.entryTime);
      expect(parsed.dataProvenance?.barTs).toBeLessThanOrEqual(
        parsed.entryTime,
      );
      expect(parsed.slippage).toBeGreaterThanOrEqual(0);
    }
    const net = (ts: readonly { netPnl?: number | undefined }[]) =>
      ts.reduce((n, t) => n + (t.netPnl ?? 0), 0);
    expect(net(trail.trades)).toBeCloseTo(net(record.trades), 3);
  });

  it("holds every Signal, timed and stamped with its bar, each actionable one with its risk decision", async () => {
    const { record, trail } = await run();
    expect(trail.signals.map((s) => s.signalId)).toEqual(
      record.signals.map((s) => s.signalId),
    );
    const decided = new Map(trail.riskLogs.map((l) => [l.signalId, l]));
    for (const signal of trail.signals) {
      const parsed = SignalSchema.parse(signal);
      expect(parsed.ts).toBeGreaterThan(0);
      // The strategy's own decisions carry the bar they were made on; the
      // Exit Engine's mechanical exits (stop, target, square-off) do not.
      if (parsed.exitReason === undefined)
        expect(parsed.dataProvenance?.barTs).toBeLessThanOrEqual(parsed.ts);
      // A HOLD is persisted, as the runtime persists it, but never reaches
      // risk; every actionable signal has exactly one decision.
      if (parsed.side === "HOLD")
        expect(decided.has(signal.signalId)).toBe(false);
      else
        expect(decided.get(signal.signalId)?.decision).toMatch(
          /approved|blocked/,
        );
    }
    expect(trail.riskLogs).toHaveLength(record.riskDecisions.length);
  });

  it("links each Trade to the Signal that opened it", async () => {
    const { trail } = await run();
    const signals = new Set(trail.signals.map((s) => s.signalId));
    expect(trail.trades.length).toBeGreaterThan(0);
    for (const trade of trail.trades) {
      expect(signals.has(trade.entrySignalId ?? "")).toBe(true);
    }
  });
});
