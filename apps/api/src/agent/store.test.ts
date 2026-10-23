import type { Db } from "mongodb";
import { describe, expect, it } from "vitest";
import { AgentAnswerDocSchema } from "@neelkanth/db";
import type { PatternObservation } from "../research/observations.js";
import type { DailyReport } from "../research/report.js";
import { runResearch, type ResearchSession } from "./loop.js";
import { ScriptedModel } from "./model.js";
import { answerDoc, auditAnswer } from "./store.js";
import { ToolContext } from "./tools.js";

/** Task 11.4 (design D7): every answer kept, and auditable without the model. */
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
class Fixed extends ToolContext {
  constructor() {
    super({} as Db, "2026-03-31");
  }
  override dailyReports(): Promise<DailyReport[]> {
    return Promise.resolve([
      {
        date: "2026-03-02",
        symbol: "NSE:X-INDEX",
        dailyResearchVersion: "1",
        features: {
          sources: { BROKER_HISTORICAL: 75 },
          ingestionVersions: [1],
        },
        models: {},
        strategies: [],
        trades: [],
        patterns: [occurrence(1), occurrence(2), occurrence(3)],
      } as unknown as DailyReport,
    ]);
  }
}
const session = (statement: string): Promise<ResearchSession> =>
  runResearch(
    "How often did ORB_BREAKOUT fire?",
    new Fixed(),
    new ScriptedModel([
      { tools: [{ name: "find_patterns", input: {} }] },
      {
        tools: [
          {
            name: "submit_answer",
            input: {
              summary: "It fired.",
              claims: [{ statement, cites: ["c1"] }],
              caveats: [],
            },
          },
        ],
      },
    ]),
    { maxCorrections: 0 },
  );

describe("keeping an answer (11.4, D7)", () => {
  it("keeps the question, asOf, versions, every call, the answer and the verdict", async () => {
    const doc = answerDoc(
      await session("It fired n = 3 times."),
      1_700_000_000_000,
    );
    expect(AgentAnswerDocSchema.parse(doc)).toEqual(doc);
    expect(doc).toMatchObject({
      question: "How often did ORB_BREAKOUT fire?",
      asOf: "2026-03-31",
      model: "scripted",
      versions: { tools: "1", answerContract: "1", loop: "1" },
      status: "ANSWERED",
      verdict: "SUPPORTED",
    });
    expect(doc.calls.map((c) => c.name)).toEqual(["find_patterns"]);
    expect(doc.answerId).toMatch(/^ans_1700000000000_[0-9a-f]{12}$/);
  });

  it("is the same document for the same session", async () => {
    const s = await session("It fired n = 3 times.");
    expect(answerDoc(s, 5)).toEqual(answerDoc(s, 5));
  });
});

describe("auditing an answer without the model (11.4, D7)", () => {
  it("re-checks and re-renders a kept answer to what was kept", async () => {
    for (const statement of ["It fired n = 3 times.", "It fired 999 times."]) {
      const doc = answerDoc(await session(statement), 1);
      expect(auditAnswer(doc)).toEqual({
        answerId: doc.answerId,
        intact: true,
        verdictHolds: true,
        renderedHolds: true,
      });
    }
  });

  it("finds a kept answer that was changed after the fact", async () => {
    const doc = answerDoc(await session("It fired 999 times."), 1);
    expect(doc.verdict).toBe("UNSUPPORTED");
    const promoted = { ...doc, verdict: "SUPPORTED" as const };
    expect(auditAnswer(promoted)).toMatchObject({
      intact: false,
      verdictHolds: false,
    });
    const rewritten = { ...doc, rendered: "It fired 999 times. SUPPORTED." };
    expect(auditAnswer(rewritten)).toMatchObject({
      intact: false,
      renderedHolds: false,
    });
  });
});
