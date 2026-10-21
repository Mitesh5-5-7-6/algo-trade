import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runGoldenPipeline, type GoldenRecord } from "./pipeline.js";
import { goldenFixture } from "./fixture.js";

const goldenPath = fileURLToPath(
  new URL("./golden-record.json", import.meta.url),
);

/**
 * The signature test of the system (plan/27 §4): run the whole machine over a
 * recorded fixture and compare EVERY candle, signal, risk decision, order,
 * fill, exit, position, and PnL against a committed golden record. Any diff
 * fails the build — an *intended* behavior change updates the record in the
 * same PR, making the consequence visible in review as a diff of trades. This
 * is Chapter 02 Principle 1 (determinism) turned into CI.
 *
 * To regenerate after an intended change: `UPDATE_GOLDEN=1 pnpm --filter
 * @neelkanth/api test` and review the resulting diff.
 */
describe("golden run (plan/27 §4)", () => {
  it("reproduces the committed golden record exactly", async () => {
    const record = await runGoldenPipeline(goldenFixture());
    const actual = `${JSON.stringify(record, null, 2)}\n`;

    if (process.env["UPDATE_GOLDEN"] === "1" || !existsSync(goldenPath)) {
      writeFileSync(goldenPath, actual);
    }
    expect(actual).toBe(readFileSync(goldenPath, "utf8"));
  });

  it("is deterministic — two runs produce identical records", async () => {
    const a = await runGoldenPipeline(goldenFixture());
    const b = await runGoldenPipeline(goldenFixture());
    expect(a).toEqual(b);
  });

  it("produces meaningful activity — signals, orders, and a realized result", async () => {
    const record: GoldenRecord = await runGoldenPipeline(goldenFixture());
    expect(record.signals.length).toBeGreaterThan(0);
    expect(record.orders.length).toBeGreaterThan(0);
    expect(record.positions.length).toBeGreaterThan(0);
    // Every order traces back to a recorded signal + risk decision.
    const signalIds = new Set(record.signals.map((s) => s.signalId));
    for (const order of record.orders) {
      expect(signalIds.has(order.signalId)).toBe(true);
    }
  });
});

/**
 * The harness's own completeness (§4.2).
 *
 * A golden record is only worth freezing if the machine that produced it is
 * the machine that trades. These assert that each newly wired half actually
 * ran — because an engine can be constructed, injected and never reached, and
 * the frozen JSON would look just as convincing either way.
 */
describe("the harness runs the whole machine, not a smaller one", () => {
  const run = (): Promise<GoldenRecord> => runGoldenPipeline(goldenFixture());

  /**
   * The feed half. Before this, the fixture handed the pipeline finished
   * candles, so normalization and aggregation — which every later number
   * depends on — were never executed at all.
   */
  it("builds its candles from ticks, at every interval production builds", async () => {
    const record = await run();
    const series = new Set(
      record.candles.map((c) => `${c.symbol}|${c.interval}`),
    );
    expect(series).toEqual(
      new Set([
        "NSE:TESTCO-EQ|1m",
        "NSE:TESTCO-EQ|5m",
        "NSE:TESTINDEX-INDEX|1m",
        "NSE:TESTINDEX-INDEX|5m",
      ]),
    );
    for (const row of record.candles) {
      expect(row.count).toBeGreaterThan(0);
    }
  });

  /**
   * The bar the aggregator is still holding when the bell rings only exists if
   * something flushes it. Unflushed, it either died with the process overnight
   * or surfaced next morning as a day-old CANDLE_CLOSED fed to live exits.
   */
  it("flushes the day's last bar, so the bar count is the tick count", async () => {
    const record = await run();
    const fiveMinute = record.candles.find(
      (c) => c.symbol === "NSE:TESTCO-EQ" && c.interval === "5m",
    );
    // 71 buckets of ticks produce 71 bars only if the final, still-open one is
    // flushed at the close; without the flush it would be 70.
    expect(fiveMinute?.count).toBe(71);
  });

  it("drives one session, and sees both of its edges", async () => {
    const record = await run();
    expect(record.sessionEvents).toEqual(["MARKET_OPEN", "MARKET_CLOSE"]);
  });

  /**
   * The three exits every position gets without configuration, in one day.
   * Each is a different path: `stop` and `target` are judged on a closed bar,
   * `square_off` on the session tick. A harness reaching only one of them
   * would leave the other two proven by unit tests alone.
   *
   * Phase 3's other exits — time, trailing stop, strategy exit, manual — need
   * exit rules, an exit verdict or an operator. The fixture configures none;
   * they are proven end to end in `exit-completeness.test.ts`, and a replay
   * that reaches them is Phase 4's acceptance (task 4.9).
   */
  it("exercises the three default exit triggers", async () => {
    const record = await run();
    const triggers = record.signals
      .filter((s) => s.reason.startsWith("exit: "))
      .map((s) => s.reason.slice("exit: ".length));
    expect(new Set(triggers)).toEqual(
      new Set(["stop", "target", "square_off"]),
    );
  });

  /** The long side cannot exercise the short side's breach comparison. */
  it("judges both a long and a short position", async () => {
    const record = await run();
    const sides = new Set(record.positions.map((p) => p.side));
    expect(sides).toEqual(new Set(["LONG", "SHORT"]));
  });

  /**
   * The protective levels have to survive signal → order → fill → position, or
   * the Exit Engine has nothing to act on. Before the Exit Engine existed this
   * chain was intact and simply unread, which is why it is asserted rather
   * than assumed.
   */
  it("carries stops and targets through to the position", async () => {
    const record = await run();
    for (const position of record.positions) {
      expect(position.stopLoss).toBeGreaterThan(0);
      expect(position.target).toBeGreaterThan(0);
    }
  });

  /**
   * The market-bias gate is the one engine that can stop a trade, and the
   * earlier harness replaced it with a constant NEUTRAL — which blocks
   * nothing, so the gate was present in the wiring and absent from the proof.
   */
  it("checks entries against a real market view, and blocks on it", async () => {
    const record = await run();
    const blocked = record.riskDecisions.filter(
      (d) => d.failedCheck === "marketBias",
    );
    expect(blocked.length).toBeGreaterThan(0);
    expect(record.marketView.detail).toContain("NSE:TESTINDEX-INDEX");
  });

  /** An intraday system that ends the day holding something has a bug. */
  it("ends the day flat", async () => {
    const record = await run();
    expect(record.openAtEnd).toBe(0);
    for (const position of record.positions) {
      expect(position.status).toBe("CLOSED");
    }
  });
});
