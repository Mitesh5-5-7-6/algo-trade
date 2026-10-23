import { describe, expect, it } from "vitest";
import {
  contextProblem,
  KNOWLEDGE_INDEX_VERSION,
  makeDocument,
} from "./document.js";

/** Task 10.1 (design D1, D2): a derived document that points at its evidence and never states a result bare. */
const base = {
  docId:
    "TRADE|DAY|2026-03-02|NSE:NIFTY50-INDEX|v1|ORB|NSE:NIFTY50-INDEX|trd_6",
  kind: "TRADE" as const,
  source: {
    collection: "research_reports",
    id: "DAY|2026-03-02|NSE:NIFTY50-INDEX|v1",
    version: 1,
    fingerprint: "f".repeat(64),
  },
  subject: { fromDate: "2026-03-02", toDate: "2026-03-02" },
  facets: {
    symbols: ["NSE:NIFTY50-INDEX"],
    patterns: ["ORB_BREAKOUT", "ORB_BREAKOUT"],
    strategies: ["ORB"],
    regimes: ["BEARISH"],
    outcome: "LOSS",
    n: 1,
  },
  title: "ORB LONG on NSE:NIFTY50-INDEX, 2026-03-02 — LOSS",
  text: "On 2026-03-02 ORB went LONG on NSE:NIFTY50-INDEX after ORB_BREAKOUT in a BEARISH regime; n = 1; net -867.96.",
};

describe("a knowledge document (10.1, D1)", () => {
  it("normalises its facets and fingerprints its content", () => {
    const d = makeDocument(base);
    expect(d.facets.patterns).toEqual(["ORB_BREAKOUT"]);
    expect(d.indexVersion).toBe(KNOWLEDGE_INDEX_VERSION);
    expect(d.contentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(
      makeDocument({
        ...base,
        facets: { ...base.facets, patterns: ["ORB_BREAKOUT"] },
      }).contentFingerprint,
    ).toBe(d.contentFingerprint);
    expect(
      makeDocument({ ...base, text: base.text.replace("-867.96", "-1") })
        .contentFingerprint,
    ).not.toBe(d.contentFingerprint);
  });

  it("points at its source, and refuses a subject that ends before it starts", () => {
    expect(makeDocument(base).source).toEqual(base.source);
    expect(() =>
      makeDocument({
        ...base,
        subject: { fromDate: "2026-03-03", toDate: "2026-03-02" },
      }),
    ).toThrow(/ends on or after/);
  });
});

describe("text carries its context (10.1, D2)", () => {
  /** The phase's own example: a rate with nothing behind it. */
  it("refuses a result without its sample size or its date", () => {
    expect(contextProblem("ORB wins 78% of the time")).toMatch(/sample size/);
    expect(contextProblem("ORB: win rate 28%, n = 638")).toMatch(/date/);
    expect(
      contextProblem("ORB: win rate 28.4%, n = 638, 2025-09-29 .. 2026-09-28"),
    ).toBeNull();
    expect(() => makeDocument({ ...base, text: "ORB lost money." })).toThrow(
      /sample size/,
    );
  });

  it("leaves text that states no result alone", () => {
    expect(
      contextProblem(
        "ORB_BREAKOUT 1.0.0: the first N minutes of the session form a range.",
      ),
    ).toBeNull();
  });
});
