import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "mongodb";
import { z } from "zod/v4";
import type { DailyReport } from "../research/report.js";
import {
  experimentHistory,
  findPatterns,
  readDailyReports,
  strategyMatrix,
  tradeHistory,
  type Provenance,
} from "../knowledge/read.js";
import { searchKnowledge } from "../knowledge/search.js";
import { findSimilarSessions } from "../knowledge/similar.js";
import { KNOWLEDGE_INDEX_VERSION } from "../knowledge/document.js";

/** Bumped whenever a tool's meaning, input or result changes (Phase 11 D1, D2). */
export const AGENT_TOOLS_VERSION = "2";

/** At most this many rows reach the model; the rest are counted (D2). */
export const MAX_ROWS = 50;

/**
 * What a cited result must carry (D3) — the read models' Provenance, or the
 * same shape for a tool whose answer is not a read model's.
 */
export interface ToolProvenance {
  n: number;
  range: { fromDate: string; toDate: string } | null;
  asOf: string | null;
  versions: Record<string, string[]>;
  data?: Provenance["data"];
  costs?: Provenance["costs"];
}

export type ToolOutcome =
  | {
      ok: true;
      /** Evidence (a read model) or memory (research search, §9.2). */
      evidence: boolean;
      provenance: ToolProvenance;
      total: number;
      rows: unknown[];
      /** Every adjustment made to the request — a date clamped to asOf. */
      notes: string[];
      /** Anything else the answer carries — a summary, an excluded list. */
      extra?: Record<string, unknown>;
    }
  | { ok: false; error: string };

/** One session's bindings: the database, the date it is asked as of, and what it has read. */
export class ToolContext {
  private reports: Promise<DailyReport[]> | undefined;

  constructor(
    readonly db: Db,
    readonly asOf: string,
  ) {}

  /** Every daily report up to asOf, read once per session. */
  dailyReports(): Promise<DailyReport[]> {
    this.reports ??= readDailyReports(this.db, { asOf: this.asOf });
    return this.reports;
  }
}

export interface AgentTool {
  definition: Anthropic.Beta.BetaTool;
  run(input: unknown, ctx: ToolContext): Promise<ToolOutcome>;
}

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("YYYY-MM-DD");
const list = (what: string) => z.array(z.string()).describe(what);
const RANGE = {
  fromDate: DATE.optional().describe("first session, YYYY-MM-DD"),
  toDate: DATE.optional().describe("last session, YYYY-MM-DD"),
};

/** The schema the API sees: strict, no `$schema` key (strict tool use). */
export function inputSchema(
  schema: z.ZodType,
): Anthropic.Beta.BetaTool.InputSchema {
  return strip(z.toJSONSchema(schema)) as Anthropic.Beta.BetaTool.InputSchema;
}

/**
 * Keywords strict tool use does not accept — numeric and string constraints
 * — removed from what the API sees; zod still checks them here.
 */
const UNSUPPORTED = new Set([
  "$schema",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);
function strip(node: unknown, names = false): unknown {
  if (Array.isArray(node)) return node.map((n) => strip(n));
  if (node === null || typeof node !== "object") return node;
  // Under `properties` the keys are input names, not keywords: keep them all.
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => names || !UNSUPPORTED.has(key))
      .map(([key, value]) => [
        key,
        names ? strip(value) : strip(value, key === "properties"),
      ]),
  );
}

/** A date range bounded by asOf (D2): a later end is clamped, and the model is told. */
function bounded(
  q: { fromDate?: string | undefined; toDate?: string | undefined },
  asOf: string,
  notes: string[],
): { fromDate?: string; toDate: string } {
  let toDate = q.toDate ?? asOf;
  if (toDate > asOf) {
    notes.push(
      `toDate ${toDate} is after asOf ${asOf}: clamped to ${asOf} — nothing after it is known`,
    );
    toDate = asOf;
  }
  if (q.fromDate !== undefined && q.fromDate > asOf)
    notes.push(
      `fromDate ${q.fromDate} is after asOf ${asOf}: nothing is known about it`,
    );
  return q.fromDate === undefined
    ? { toDate }
    : { fromDate: q.fromDate, toDate };
}

const capped = <T>(rows: readonly T[]): T[] => rows.slice(0, MAX_ROWS);

/**
 * A number as the model reads it (Phase 11 acceptance F2): an amount to two
 * decimals, a fraction to four, an integer as it is — so an answer quotes
 * -191,953.29, not -191953.28649999998. Rows and extras only: the provenance
 * stays exact.
 */
export function tidy(v: unknown): unknown {
  if (typeof v === "number")
    return !Number.isFinite(v) || Number.isInteger(v)
      ? v
      : Number(v.toFixed(Math.abs(v) >= 1 ? 2 : 4));
  if (Array.isArray(v)) return v.map(tidy);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tidy(x)]));
  return v;
}
const shownNote = (total: number): string[] =>
  total > MAX_ROWS
    ? [
        `showing the first ${String(MAX_ROWS)} of ${String(total)} rows; n and the summary count all ${String(total)}`,
      ]
    : [];
/** Only the keys that were given — an absent filter filters nothing. */
const given = <T extends Record<string, unknown>>(
  o: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };

/** A tool from its zod input schema and a run over parsed input. */
function tool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<ToolOutcome>,
): AgentTool {
  return {
    definition: {
      name,
      description,
      strict: true,
      input_schema: inputSchema(schema),
    },
    async run(input, ctx) {
      const parsed = schema.safeParse(input);
      if (!parsed.success)
        return {
          ok: false,
          error: `invalid input for ${name}: ${z.prettifyError(parsed.error)}`,
        };
      try {
        const out = await run(parsed.data, ctx);
        return out.ok
          ? {
              ...out,
              rows: out.rows.map(tidy),
              ...(out.extra === undefined
                ? {}
                : { extra: tidy(out.extra) as Record<string, unknown> }),
            }
          : out;
      } catch (e) {
        return {
          ok: false,
          error: `${name} failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  };
}

const provenanceOf = (p: Provenance): ToolProvenance => ({
  n: p.n,
  range: p.range,
  asOf: p.asOf,
  versions: p.versions,
  data: p.data,
  costs: p.costs,
});

const findPatternsTool = tool(
  "find_patterns",
  "Where and when patterns occurred, in which regime, and what each strategy did with each occurrence — and how the Trade it led to ended. Returns the occurrences in time order with a provenance (n, the sessions read, versions, data version, cost models).",
  z.strictObject({
    patterns: list("pattern ids, e.g. ORB_BREAKOUT; any of them").optional(),
    regimes: list("BULLISH, BEARISH or NEUTRAL; any of them").optional(),
    symbols: list("instruments, e.g. NSE:NIFTY50-INDEX").optional(),
    direction: z.string().describe("BULLISH or BEARISH").optional(),
    ...RANGE,
  }),
  async (q, ctx) => {
    const notes: string[] = [];
    const a = findPatterns(
      await ctx.dailyReports(),
      given({ ...q, ...bounded(q, ctx.asOf, notes), asOf: ctx.asOf }),
    );
    return {
      ok: true,
      evidence: true,
      provenance: provenanceOf(a),
      total: a.occurrences.length,
      rows: capped(a.occurrences),
      notes: [...notes, ...shownNote(a.occurrences.length)],
    };
  },
);

const tradeHistoryTool = tool(
  "trade_history",
  "Completed Trades — entry, exit, reason, outcome — by strategy, by a pattern among those that preceded the entry, by the regime at entry, by outcome. The summary (wins, losses, net, expectancy per Trade) is over every Trade matched, not only the rows shown.",
  z.strictObject({
    strategies: list("strategy types, e.g. ORB, RSI, EMA_CROSSOVER").optional(),
    patterns: list("pattern ids that preceded the entry").optional(),
    regimes: list("regime at entry: BULLISH, BEARISH or NEUTRAL").optional(),
    outcome: z.enum(["WIN", "LOSS", "FLAT"]).optional(),
    symbols: list("instruments").optional(),
    ...RANGE,
  }),
  async (q, ctx) => {
    const notes: string[] = [];
    const a = tradeHistory(
      await ctx.dailyReports(),
      given({ ...q, ...bounded(q, ctx.asOf, notes), asOf: ctx.asOf }),
    );
    return {
      ok: true,
      evidence: true,
      provenance: provenanceOf(a),
      total: a.trades.length,
      rows: capped(
        a.trades.map((t) => ({
          date: t.date,
          key: t.key,
          strategyType: t.strategyType,
          symbol: t.symbol,
          side: t.side,
          entry: { price: t.entry.price, reason: t.entry.reason },
          exit: { price: t.exit.price, reason: t.exit.reason },
          outcome: t.outcome,
          held: t.held,
          preceding: {
            regime: t.preceding.regime,
            patterns: t.preceding.patterns.map((p) => p.patternId),
          },
        })),
      ),
      notes: [...notes, ...shownNote(a.trades.length)],
      extra: { summary: a.summary },
    };
  },
);

const strategyMatrixTool = tool(
  "strategy_matrix",
  "One pattern against every strategy: for each strategy, how often it was on the instrument when the pattern fired, what it did (ENTERED, SIGNALLED, HOLDING, FLAT), and how the Trades it took on the pattern ended. Strategies that could not run are listed with why. Give regimes to count only the occurrences in those regimes.",
  z.strictObject({
    patternId: z.string().describe("the pattern, e.g. EMA_CROSS"),
    regimes: list(
      "only occurrences in these regimes: BULLISH, BEARISH, NEUTRAL",
    ).optional(),
    symbols: list("instruments").optional(),
    ...RANGE,
  }),
  async (q, ctx) => {
    const notes: string[] = [];
    const a = strategyMatrix(await ctx.dailyReports(), {
      ...given({ symbols: q.symbols, regimes: q.regimes }),
      ...bounded(q, ctx.asOf, notes),
      asOf: ctx.asOf,
      patternId: q.patternId,
    });
    return {
      ok: true,
      evidence: true,
      provenance: provenanceOf(a),
      total: a.rows.length,
      rows: a.rows,
      notes,
      extra: { patternId: a.patternId, excluded: a.excluded },
    };
  },
);

const experimentHistoryTool = tool(
  "experiment_history",
  "Counterfactual runs, registered hypotheses and their tested findings (verdict, n, out-of-sample) for a strategy or a pattern, with the counterfactual and gate-policy versions behind them.",
  z.strictObject({
    strategies: list("strategy types").optional(),
    patterns: list("pattern ids").optional(),
  }),
  async (q, ctx) => {
    const a = await experimentHistory(ctx.db, given({ ...q, asOf: ctx.asOf }));
    return {
      ok: true,
      evidence: true,
      provenance: provenanceOf(a),
      total: a.entries.length,
      rows: capped(a.entries),
      notes: shownNote(a.entries.length),
    };
  },
);

const similarSessionsTool = tool(
  "similar_sessions",
  "The sessions most like a given day — by return, gap, range, volatility, regime and pattern counts, standardised over the sessions up to it — never using a session after it. Returns the nearest with their distances and features.",
  z.strictObject({
    date: DATE.describe("the day to compare, YYYY-MM-DD"),
    symbol: z.string().describe("its instrument, e.g. NSE:NIFTY50-INDEX"),
    k: z.number().describe("how many, 1 to 20; default 5").optional(),
    sameSymbol: z
      .boolean()
      .describe("only the same instrument; default false")
      .optional(),
  }),
  async (q, ctx) => {
    if (q.date > ctx.asOf)
      return {
        ok: false,
        error: `${q.date} is after asOf ${ctx.asOf}: nothing is known about it`,
      };
    const k = Math.min(20, Math.max(1, Math.round(q.k ?? 5)));
    const a = await findSimilarSessions(ctx.db, {
      date: q.date,
      symbol: q.symbol,
      k,
      asOf: q.date,
      ...given({ sameSymbol: q.sameSymbol }),
    });
    if (a === null)
      return {
        ok: false,
        error: `no daily report for ${q.symbol} on ${q.date}`,
      };
    return {
      ok: true,
      evidence: true,
      provenance: {
        n: a.poolSize,
        range: a.range,
        asOf: a.asOf,
        versions: { similarity: [a.modelVersion] },
      },
      total: a.nearest.length,
      rows: a.nearest,
      notes: [],
      extra: { target: a.target, dimensions: a.dimensions },
    };
  },
);

const KINDS = [
  "DAY",
  "TRADE",
  "CHART",
  "WINDOW",
  "COUNTERFACTUAL",
  "HYPOTHESIS",
  "FINDING",
  "DETECTOR",
] as const;

const searchResearchTool = tool(
  "search_research",
  'Search the research documents — days, Trades, weekly/monthly/quarterly windows, experiments, hypotheses, findings, detector definitions — by facet or by text. This is memory that points at the evidence: use it to find what to look at, then answer with the evidence tools. Text drops English stop words ("up", "down"); quote a phrase to keep them: "gap down".',
  z.strictObject({
    text: z.string().describe("free text; quote a phrase").optional(),
    kinds: z.array(z.enum(KINDS)).optional(),
    symbols: list("instruments").optional(),
    patterns: list("pattern ids").optional(),
    strategies: list("strategy types").optional(),
    regimes: list("regimes").optional(),
    outcome: z
      .string()
      .describe("WIN/LOSS/FLAT for a Trade; a verdict for a finding")
      .optional(),
    limit: z.number().describe("1 to 50; default 20").optional(),
    ...RANGE,
  }),
  async (q, ctx) => {
    const notes: string[] = [];
    const { toDate } = bounded(q, ctx.asOf, notes);
    const hits = await searchKnowledge(ctx.db, {
      ...given({
        text: q.text,
        kinds: q.kinds,
        symbols: q.symbols,
        patterns: q.patterns,
        strategies: q.strategies,
        regimes: q.regimes,
        outcome: q.outcome,
        fromDate: q.fromDate,
      }),
      toDate,
      asOf: ctx.asOf,
      limit: Math.min(MAX_ROWS, Math.max(1, Math.round(q.limit ?? 20))),
    });
    const from = hits.reduce<string | null>(
      (m, h) => (m === null || h.subject.fromDate < m ? h.subject.fromDate : m),
      null,
    );
    const to = hits.reduce<string | null>(
      (m, h) => (m === null || h.subject.toDate > m ? h.subject.toDate : m),
      null,
    );
    return {
      ok: true,
      evidence: false,
      provenance: {
        n: hits.length,
        range:
          from === null || to === null ? null : { fromDate: from, toDate: to },
        asOf: ctx.asOf,
        versions: { knowledgeIndex: [KNOWLEDGE_INDEX_VERSION] },
      },
      total: hits.length,
      rows: hits.map((h) => ({
        docId: h.docId,
        kind: h.kind,
        title: h.title,
        text: h.text,
        subject: h.subject,
        score: h.score,
      })),
      notes,
    };
  },
);

/**
 * The agent's whole tool surface (D1): six read-only tools over the research.
 * Nothing here can write, trade, or read a secret — and there is no other
 * tool. newsContext, runBacktest and runWalkForward are deferred (Q2).
 */
export const AGENT_TOOLS: readonly AgentTool[] = [
  findPatternsTool,
  tradeHistoryTool,
  strategyMatrixTool,
  experimentHistoryTool,
  similarSessionsTool,
  searchResearchTool,
];

export function toolNamed(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.definition.name === name);
}
