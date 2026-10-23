import type { Db } from "mongodb";
import { describe, expect, it } from "vitest";
import type { PatternObservation } from "../research/observations.js";
import type { DailyReport } from "../research/report.js";
import { runResearch, SYSTEM_PROMPT } from "./loop.js";
import { ScriptedModel, type ScriptedStep } from "./model.js";
import { ToolContext } from "./tools.js";

/** Task 11.3 (design D6): the loop, on a scripted model — no network, no key. */
const occurrence = (ts: number): PatternObservation => ({
  patternId: "ORB_BREAKOUT",
  detectorVersion: "1.0.0",
  ts,
  direction: "BULLISH",
  evidence: {},
  marketContext: {},
  regime: "BULLISH",
  strategies: {},
});
const report = (date: string, n: number): DailyReport =>
  ({
    date,
    symbol: "NSE:X-INDEX",
    dailyResearchVersion: "1",
    features: { sources: { BROKER_HISTORICAL: 75 }, ingestionVersions: [1] },
    models: {},
    strategies: [],
    trades: [],
    patterns: Array.from({ length: n }, (_, i) => occurrence(i)),
  }) as unknown as DailyReport;
class Fixed extends ToolContext {
  constructor() {
    super({} as Db, "2026-03-31");
  }
  override dailyReports(): Promise<DailyReport[]> {
    return Promise.resolve([report("2026-03-02", 7), report("2026-03-09", 4)]);
  }
}

const FIND = { name: "find_patterns", input: { patterns: ["ORB_BREAKOUT"] } };
const submit = (statement: string, cites = ["c1"]) => ({
  name: "submit_answer",
  input: {
    summary: "ORB_BREAKOUT fired.",
    claims: [{ statement, cites }],
    caveats: [],
  },
});
const GOOD = submit(
  "ORB_BREAKOUT fired n = 11 times between 2026-03-02 and 2026-03-09.",
);
const BAD = submit("ORB_BREAKOUT fired 999 times.");
const ask = (steps: ScriptedStep[], options = {}) => {
  const model = new ScriptedModel(steps);
  return {
    model,
    session: runResearch(
      "How often did ORB_BREAKOUT fire?",
      new Fixed(),
      model,
      options,
    ),
  };
};

describe("a session that answers (11.3)", () => {
  it("runs the tools, checks the answer, and renders it with its evidence", async () => {
    const { model, session } = ask([{ tools: [FIND] }, { tools: [GOOD] }]);
    const s = await session;
    expect(s).toMatchObject({
      status: "ANSWERED",
      verdict: "SUPPORTED",
      turns: 2,
      corrections: 0,
    });
    expect(s.calls.map((c) => [c.id, c.name, c.outcome.ok])).toEqual([
      ["c1", "find_patterns", true],
    ]);
    expect(s.rendered).toContain(
      "[c1 find_patterns; n = 11; sessions 2026-03-02 .. 2026-03-09; as of 2026-03-31",
    );
    expect(s.versions).toEqual({ tools: "1", answerContract: "1", loop: "1" });

    // What the model was sent: the asOf in the question, every block of its
    // own turn back unchanged, the result labelled with its call id.
    const [first, second] = model.requests;
    expect(first?.system).toBe(SYSTEM_PROMPT);
    expect(first?.messages[0]).toEqual({
      role: "user",
      content: "As of 2026-03-31: How often did ORB_BREAKOUT fire?",
    });
    expect(first?.tools.map((t) => t.name)).toEqual([
      "find_patterns",
      "trade_history",
      "strategy_matrix",
      "experiment_history",
      "similar_sessions",
      "search_research",
      "submit_answer",
    ]);
    expect(second?.messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "tool_use", name: "find_patterns" }],
    });
    const result = (
      second?.messages[2]?.content as { content: string; is_error: boolean }[]
    )[0];
    expect(result?.is_error).toBe(false);
    expect(JSON.parse(result?.content ?? "{}")).toMatchObject({
      call: "c1",
      ok: true,
      provenance: { n: 11 },
    });
  });

  it("accepts a submit citing a call made in the same turn", async () => {
    const s = await ask([{ tools: [FIND, GOOD] }]).session;
    expect(s).toMatchObject({
      status: "ANSWERED",
      verdict: "SUPPORTED",
      turns: 1,
    });
  });
});

describe("corrections (11.3, D3)", () => {
  it("sends a rejected answer back with its reasons, and accepts the corrected one", async () => {
    const { model, session } = ask([
      { tools: [FIND] },
      { tools: [BAD] },
      { tools: [GOOD] },
    ]);
    const s = await session;
    expect(s).toMatchObject({
      status: "ANSWERED",
      verdict: "SUPPORTED",
      corrections: 1,
    });
    const back = (
      model.requests[2]?.messages.at(-1)?.content as {
        content: string;
        is_error: boolean;
      }[]
    )[0];
    expect(back?.is_error).toBe(true);
    expect(back?.content).toContain(
      "states 999, which is in none of the results it cites",
    );
  });

  it("returns UNSUPPORTED, with the reasons, after the last correction", async () => {
    const s = await ask([
      { tools: [FIND] },
      { tools: [BAD] },
      { tools: [BAD] },
      { tools: [BAD] },
      { tools: [GOOD] },
    ]).session;
    expect(s).toMatchObject({
      status: "ANSWERED",
      verdict: "UNSUPPORTED",
      corrections: 2,
      turns: 4,
    });
    expect(s.rendered).toContain("UNSUPPORTED:");
    expect(s.rendered).toContain("states 999");
  });

  it("returns an invalid submission as an error, and goes on", async () => {
    const s = await ask([
      { tools: [FIND] },
      { tools: [{ name: "submit_answer", input: { summary: "x" } }] },
      { tools: [GOOD] },
    ]).session;
    expect(s).toMatchObject({ verdict: "SUPPORTED", corrections: 0, turns: 3 });
  });
});

describe("every other ending (11.3, D6)", () => {
  it("a refusal ends the session, nothing run", async () => {
    const s = await ask([{ refusal: true }]).session;
    expect(s).toMatchObject({
      status: "REFUSED",
      verdict: "UNSUPPORTED",
      calls: [],
      answer: null,
    });
    expect(s.rendered).toBe(
      "UNSUPPORTED: no answer — the model declined the question.",
    );
  });

  it("a cut-off turn ends it", async () => {
    expect(
      await ask([{ tools: [FIND] }, { truncated: true }]).session,
    ).toMatchObject({ status: "TRUNCATED", verdict: "UNSUPPORTED" });
  });

  it("no answer within the turns allowed is EXHAUSTED", async () => {
    const s = await ask(
      [
        { tools: [FIND] },
        { tools: [FIND] },
        { tools: [FIND] },
        { tools: [GOOD] },
      ],
      { maxTurns: 3 },
    ).session;
    expect(s).toMatchObject({
      status: "EXHAUSTED",
      verdict: "UNSUPPORTED",
      turns: 3,
    });
    expect(s.calls).toHaveLength(3);
  });

  it("a turn with no tool call is asked to finish", async () => {
    const { model, session } = ask([
      { tools: [FIND] },
      { text: "ORB fired often." },
      { tools: [GOOD] },
    ]);
    expect(await session).toMatchObject({ verdict: "SUPPORTED", turns: 3 });
    expect(model.requests[2]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("submit_answer") as string,
    });
  });

  /** D1: there is no order tool; asking for one is an error the model reads. */
  it("a tool that does not exist is an error result naming the tools there are", async () => {
    const order = {
      name: "place_order",
      input: { symbol: "NSE:NIFTY50-INDEX", side: "BUY" },
    };
    const decline = submit(
      "No tool can place an order; this system only researches.",
      [],
    );
    const { model, session } = ask([{ tools: [order] }, { tools: [decline] }]);
    const s = await session;
    expect(s).toMatchObject({ status: "ANSWERED", verdict: "SUPPORTED" });
    expect(s.calls[0]?.outcome).toEqual({
      ok: false,
      error:
        "there is no tool place_order; the tools are find_patterns, trade_history, strategy_matrix, experiment_history, similar_sessions, search_research",
    });
    const back = (
      model.requests[1]?.messages.at(-1)?.content as { is_error: boolean }[]
    )[0];
    expect(back?.is_error).toBe(true);
  });
});
