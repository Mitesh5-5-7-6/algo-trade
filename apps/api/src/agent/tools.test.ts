import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "mongodb";
import { describe, expect, it } from "vitest";
import type { PatternObservation } from "../research/observations.js";
import type { DailyReport } from "../research/report.js";
import { z } from "zod/v4";
import {
  AGENT_TOOLS,
  inputSchema,
  tidy,
  MAX_ROWS,
  ToolContext,
  toolNamed,
} from "./tools.js";

/** Task 11.1 (design D1, D2): six read-only tools, bound to asOf, capped. */
const HERE = fileURLToPath(new URL(".", import.meta.url));

/**
 * D1: the agent's code may import only what this allowlist names — the
 * knowledge read models, the SDK, validation, and its own modules. Not the
 * indexer (it writes), not a broker, order, risk or settings module.
 */
const ALLOWED = [
  /^\.\/[\w-]+\.js$/,
  /^\.\.\/knowledge\/(read|search|similar|document)\.js$/,
  /^\.\.\/research\/(report|observations|evidence)\.js$/, // types only
  /^@anthropic-ai\/sdk$/,
  /^openai$/, // the OpenAI-compatible adapter (D8)
  /^mongodb$/,
  /^zod\/v4$/,
  /^node:crypto$/,
  /^@neelkanth\/core$/, // canonicalJson
  /^@neelkanth\/db$/, // AgentAnswersRepository only — checked below
];
/** From the database package, only the agent's own collection (D7). */
const DB_NAMES = new Set([
  "AgentAnswersRepository",
  "AgentAnswerDoc",
  "type AgentAnswerDoc",
]);

describe("nothing but the research is reachable (11.1, D1)", () => {
  it("imports only from the allowlist", () => {
    const files = readdirSync(HERE).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    const offending: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(HERE, f), "utf8");
      for (const m of src.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1] ?? "";
        if (!ALLOWED.some((r) => r.test(spec))) offending.push(`${f}: ${spec}`);
      }
    }
    expect(offending).toEqual([]);
  });

  it("takes nothing from the database package but its own answers' repository", () => {
    const names: string[] = [];
    const files = readdirSync(HERE).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    for (const f of files)
      for (const m of readFileSync(join(HERE, f), "utf8").matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"@neelkanth\/db"/g,
      ))
        names.push(
          ...(m[1] ?? "")
            .split(",")
            .map((n) => n.trim())
            .filter(Boolean),
        );
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => !DB_NAMES.has(n))).toEqual([]);
  });

  it("exposes exactly the six research tools — no news, backtest or walk-forward (Q2)", () => {
    expect(AGENT_TOOLS.map((t) => t.definition.name)).toEqual([
      "find_patterns",
      "trade_history",
      "strategy_matrix",
      "experiment_history",
      "similar_sessions",
      "search_research",
    ]);
  });
});

/** Every object closed, no keyword strict tool use rejects. */
function schemaProblems(node: unknown, path = "$", names = false): string[] {
  if (Array.isArray(node))
    return node.flatMap((n, i) => schemaProblems(n, `${path}[${String(i)}]`));
  if (node === null || typeof node !== "object") return [];
  const o = node as Record<string, unknown>;
  const out: string[] = [];
  // Under `properties` the keys are input names: check what each holds.
  if (names)
    return Object.entries(o).flatMap(([k, v]) =>
      schemaProblems(v, `${path}.${k}`),
    );
  if (o["type"] === "object" && o["additionalProperties"] !== false)
    out.push(`${path}: object not closed`);
  for (const k of [
    "$schema",
    "pattern",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
  ])
    if (k in o) out.push(`${path}: ${k}`);
  for (const [k, v] of Object.entries(o))
    out.push(...schemaProblems(v, `${path}.${k}`, k === "properties"));
  return out;
}

describe("strict schemas (11.1)", () => {
  it("every tool is strict, closed, and free of unsupported keywords", () => {
    for (const t of AGENT_TOOLS) {
      expect(t.definition.strict).toBe(true);
      expect(t.definition.input_schema.type).toBe("object");
      expect(schemaProblems(t.definition.input_schema)).toEqual([]);
    }
  });

  /** An input named like a keyword is an input, not a keyword. */
  it("strips constraints, never an input that shares a keyword's name", () => {
    const s = inputSchema(
      z.strictObject({ pattern: z.string().regex(/^x$/), minimum: z.number() }),
    );
    expect(Object.keys(s.properties ?? {})).toEqual(["pattern", "minimum"]);
    expect(schemaProblems(s)).toEqual([]);
  });

  /** D2: asOf is the session's, never the model's to choose. */
  it("no tool takes an asOf", () => {
    for (const t of AGENT_TOOLS)
      expect(
        Object.keys(t.definition.input_schema.properties ?? {}),
      ).not.toContain("asOf");
  });

  it("refuses invalid input as an error result, not a crash", async () => {
    const ctx = new ToolContext({} as Db, "2026-03-31");
    const out = await toolNamed("strategy_matrix")?.run(
      { symbols: ["X"] },
      ctx,
    );
    expect(out).toMatchObject({ ok: false });
    expect(out?.ok === false && out.error).toMatch(
      /invalid input for strategy_matrix/,
    );
    expect(
      await toolNamed("find_patterns")?.run({ toDate: "31/03/2026" }, ctx),
    ).toMatchObject({ ok: false });
  });
});

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
const report = (date: string, occurrences: number): DailyReport =>
  ({
    date,
    symbol: "NSE:X-INDEX",
    dailyResearchVersion: "1",
    features: { sources: { BROKER_HISTORICAL: 75 }, ingestionVersions: [1] },
    models: {},
    strategies: [],
    trades: [],
    patterns: Array.from({ length: occurrences }, (_, i) => occurrence(i)),
  }) as unknown as DailyReport;

/** A session whose reports are given, not read — the tools' logic alone. */
class Fixed extends ToolContext {
  constructor(
    asOf: string,
    private readonly fixed: DailyReport[],
  ) {
    super({} as Db, asOf);
  }
  override dailyReports(): Promise<DailyReport[]> {
    return Promise.resolve(this.fixed);
  }
}

describe("bound to asOf, capped in size (11.1, D2)", () => {
  const reports = [report("2026-03-02", 3), report("2026-03-09", 2)];

  it("clamps a range reaching past asOf, says so, and reads nothing after it", async () => {
    const out = await toolNamed("find_patterns")?.run(
      { toDate: "2026-03-31" },
      new Fixed("2026-03-04", reports),
    );
    if (out?.ok !== true) throw new Error("expected an answer");
    expect(out.provenance).toMatchObject({
      n: 3,
      asOf: "2026-03-04",
      range: { fromDate: "2026-03-02", toDate: "2026-03-02" },
    });
    expect(out.notes.join(" ")).toMatch(/clamped to 2026-03-04/);
  });

  it("shows at most MAX_ROWS rows while n counts them all", async () => {
    const out = await toolNamed("find_patterns")?.run(
      {},
      new Fixed("2026-03-31", [report("2026-03-02", MAX_ROWS + 10)]),
    );
    if (out?.ok !== true) throw new Error("expected an answer");
    expect(out.rows).toHaveLength(MAX_ROWS);
    expect(out.total).toBe(MAX_ROWS + 10);
    expect(out.provenance.n).toBe(MAX_ROWS + 10);
    expect(out.notes.join(" ")).toMatch(/showing the first 50 of 60/);
  });

  it("refuses a similar-sessions day after asOf", async () => {
    const out = await toolNamed("similar_sessions")?.run(
      { date: "2026-03-09", symbol: "NSE:X-INDEX" },
      new Fixed("2026-03-04", reports),
    );
    expect(out).toEqual({
      ok: false,
      error: "2026-03-09 is after asOf 2026-03-04: nothing is known about it",
    });
  });

  /** Phase 11 acceptance F2: the model quoted -191953.28649999998. */
  it("rounds what the model reads — amounts to 2 decimals, fractions to 4 — and leaves provenance exact", async () => {
    expect(
      tidy({
        net: -191953.2865,
        rate: 0.283741,
        n: 638,
        gap: -0.021137,
        at: "x",
        none: null,
      }),
    ).toEqual({
      net: -191953.29,
      rate: 0.2837,
      n: 638,
      gap: -0.0211,
      at: "x",
      none: null,
    });
    const withTrade = {
      ...report("2026-03-02", 0),
      trades: [
        {
          key: "ORB|X|1",
          strategyType: "ORB",
          symbol: "NSE:X-INDEX",
          side: "LONG",
          entry: { price: 22576.876543, reason: null },
          exit: { price: 22500.1, reason: "STOP_LOSS" },
          outcome: {
            result: "LOSS",
            net: -76.776543,
            gross: -70,
            charges: 6.5,
            slippage: 0.276543,
            netPerUnit: -76.776543,
          },
          held: { bars: 3, minutes: 15 },
          preceding: { regime: "BULLISH", patterns: [] },
        },
      ],
      models: { slippage: { version: "1" }, transactionCost: { version: "1" } },
    } as unknown as DailyReport;
    const out = await toolNamed("trade_history")?.run(
      {},
      new Fixed("2026-03-31", [withTrade]),
    );
    if (out?.ok !== true) throw new Error("expected an answer");
    const rows = JSON.stringify(out.rows);
    expect(rows).not.toContain("22576.876543");
    expect(rows).toContain("22576.88");
    expect(rows).toContain("-76.78");
    expect(out.extra).toMatchObject({ summary: { net: -76.78 } });
  });

  it("marks research search as memory, the read models as evidence (§9.2)", async () => {
    const out = await toolNamed("find_patterns")?.run(
      {},
      new Fixed("2026-03-31", reports),
    );
    expect(out).toMatchObject({ ok: true, evidence: true });
  });
});
