import { describe, expect, it } from "vitest";
import { strategyVersionOf, type Trade } from "@neelkanth/core";
import { runHistoricalReplay } from "../replay/run.js";
import {
  emaStrategy,
  goldenBudget,
  historicalBars,
} from "../replay/test-support.js";
import { compareWithReplay, type ParityInput } from "./parity.js";

/**
 * Task 14.5 (design D6): a paper session held against the replay of its own
 * bars, decision by decision. The golden day replayed is both sides here, so
 * "the same session compares clean" is checked on real decisions, and each
 * perturbation must surface as exactly the difference it is.
 */
const FIVE_MIN = 5 * 60_000;

async function goldenTrail() {
  const run = await runHistoricalReplay({
    strategy: emaStrategy(),
    candles: await historicalBars([0]),
    hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
    ...goldenBudget(),
    seed: 0,
  });
  return run.trail;
}

async function input(
  perturb: (paper: ParityInput["paper"]) => void = () => undefined,
): Promise<ParityInput> {
  const replay = await goldenTrail();
  const paper = structuredClone(replay);
  perturb(paper);
  return {
    paper,
    replay,
    replayedVersions: new Map([
      [emaStrategy().strategyId, strategyVersionOf(emaStrategy())],
    ]),
    intervalMs: FIVE_MIN,
  };
}

const firstClosed = (trades: Trade[]): Trade => {
  const t = trades.find((x) => x.status === "CLOSED");
  if (t === undefined) throw new Error("the golden day closed no Trade");
  return t;
};

describe("parity against the replay (§14.5, D6)", () => {
  it("finds nothing to say about a session identical to its replay", async () => {
    const result = compareWithReplay(await input());

    // Hollow if the day decided nothing.
    expect(result.compared.paperSignals).toBeGreaterThan(0);
    expect(result.compared.paperTrades).toBeGreaterThan(0);
    expect(result.differences).toEqual([]);
    expect(result.clean).toBe(true);
  });

  it("names a Trade the paper session never made", async () => {
    const result = compareWithReplay(
      await input((paper) => {
        paper.trades.shift();
      }),
    );
    expect(result.clean).toBe(false);
    expect(result.differences).toEqual([
      expect.objectContaining({
        kind: "TRADE",
        field: "presence",
        paper: "absent",
      }),
    ]);
  });

  it("names a signal on a bar the replay did not decide on", async () => {
    const result = compareWithReplay(
      await input((paper) => {
        const s = paper.signals.find(
          (x) => x.side !== "HOLD" && x.dataProvenance !== undefined,
        );
        if (s?.dataProvenance === undefined) throw new Error("no bar signal");
        s.dataProvenance.barTs += FIVE_MIN;
      }),
    );
    const presence = result.differences.filter(
      (d) => d.kind === "SIGNAL" && d.field === "presence",
    );
    // One side absent on each bar: the moved signal, and where it was.
    expect(presence).toHaveLength(2);
  });

  it("names a risk verdict that went the other way", async () => {
    const result = compareWithReplay(
      await input((paper) => {
        const log = paper.riskLogs.find((l) => l.decision === "approved");
        if (log === undefined) throw new Error("nothing approved");
        log.decision = "blocked";
        log.failedCheck = "dailyLoss";
      }),
    );
    expect(result.differences).toEqual([
      expect.objectContaining({
        kind: "RISK",
        paper: "blocked (dailyLoss)",
        replay: "approved",
      }),
    ]);
  });

  it("allows tick-against-bar timing within the tolerance, and no further", async () => {
    const within = compareWithReplay(
      await input((paper) => {
        const t = firstClosed(paper.trades);
        t.entryPrice *= 1.0009; // 9 bps
        t.exitTime = (t.exitTime ?? 0) + FIVE_MIN; // one bar
      }),
    );
    expect(within.differences).toEqual([]);

    const beyond = compareWithReplay(
      await input((paper) => {
        const t = firstClosed(paper.trades);
        t.entryPrice *= 1.0011; // 11 bps
        t.exitTime = (t.exitTime ?? 0) + 2 * FIVE_MIN; // two bars
      }),
    );
    expect(beyond.differences.map((d) => d.field).sort()).toEqual([
      "entryPrice",
      "exitTime",
    ]);
  });

  it("names a Trade that ended for another reason", async () => {
    const result = compareWithReplay(
      await input((paper) => {
        firstClosed(paper.trades).exitReason = "BROKER_RECONCILIATION";
      }),
    );
    expect(result.differences).toEqual([
      expect.objectContaining({
        kind: "TRADE",
        field: "exitReason",
        paper: "BROKER_RECONCILIATION",
      }),
    ]);
  });

  it("names a strategy edited since, once, and one the replay could not run", async () => {
    const base = await input((paper) => {
      for (const s of paper.signals) s.strategyVersion = "edited";
    });
    const result = compareWithReplay({
      ...base,
      excluded: [{ strategyId: "str_chain", reason: "needs an option chain" }],
    });
    expect(result.differences).toEqual([
      expect.objectContaining({ kind: "REPLAY", key: "str_chain" }),
      expect.objectContaining({
        kind: "STRATEGY_VERSION",
        key: emaStrategy().strategyId,
        paper: "edited",
      }),
    ]);
  });
});
