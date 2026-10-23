import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import { inputSchema, type ToolOutcome, type ToolProvenance } from "./tools.js";

/** Bumped whenever what an answer must be, or how it is checked, changes (D3, D4). */
export const ANSWER_CONTRACT_VERSION = "1";

/** One tool call of a session, as it ran. */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  outcome: ToolOutcome;
}

export const SubmittedAnswerSchema = z.strictObject({
  summary: z
    .string()
    .describe(
      "Two or three sentences answering the question. State no number here that is not in a claim.",
    ),
  claims: z
    .array(
      z.strictObject({
        statement: z
          .string()
          .describe(
            "One finding, in a sentence. Every number in it must be in a result it cites.",
          ),
        cites: z
          .array(z.string())
          .describe("the ids of the tool calls this rests on"),
      }),
    )
    .describe(
      "the findings; none if the evidence does not answer the question",
    ),
  caveats: z
    .array(z.string())
    .describe(
      "what the evidence cannot say — too few Trades, a tool that does not exist, a period not yet researched",
    ),
});
export type SubmittedAnswer = z.infer<typeof SubmittedAnswerSchema>;

/** The tool the model ends a session with (D3). */
export const SUBMIT_ANSWER_TOOL: Anthropic.Tool = {
  name: "submit_answer",
  description:
    "Finish: submit the answer as claims, each citing the ids of the tool calls it rests on. A checker verifies every number and date against the cited results; a rejected answer comes back with the reasons.",
  strict: true,
  input_schema: inputSchema(SubmittedAnswerSchema),
};

export interface ClaimCheck {
  index: number;
  statement: string;
  problems: string[];
}

export interface AnswerCheck {
  ok: boolean;
  claims: ClaimCheck[];
  /** Problems with the answer as a whole. */
  problems: string[];
}

const DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
/**
 * A number as written in prose: 1,940 · -94,404.26 · 28.4% · 0.05 — but not
 * one inside an identifier (H-0001, 2026-W10, Q1, EMA9, 5m) or a time (12:40).
 */
const NUMBER =
  /(?<![\w.:-])[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?(?![\w:-]|\.\d)/g;

export interface WrittenNumber {
  text: string;
  value: number;
  decimals: number;
  percent: boolean;
}

/** The numbers a sentence states, dates and identifiers aside. */
export function numbersIn(sentence: string): WrittenNumber[] {
  const prose = sentence.replace(DATE, " ").replace(/\b\d{1,2}:\d{2}\b/g, " ");
  return [...prose.matchAll(NUMBER)].map((m) => {
    const text = m[0];
    const percent = text.endsWith("%");
    const digits = text.replace(/[%,]/g, "").replace("−", "-");
    const dot = digits.indexOf(".");
    return {
      text,
      value: Number(digits),
      decimals: dot === -1 ? 0 : digits.length - dot - 1,
      percent,
    };
  });
}

/** Every number a result holds — values, and the numbers inside its strings. */
function numbersOf(node: unknown, out: number[] = []): number[] {
  if (typeof node === "number" && Number.isFinite(node)) out.push(node);
  else if (typeof node === "string")
    for (const m of node.matchAll(/-?\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
  else if (Array.isArray(node)) for (const n of node) numbersOf(n, out);
  else if (node !== null && typeof node === "object")
    for (const v of Object.values(node)) numbersOf(v, out);
  return out;
}

/**
 * Whether a result holds the written number (D3): to the precision written,
 * either sign ("lost 94,404" is a net of −94,404), a percentage as itself or
 * as a fraction × 100.
 */
export function holds(values: readonly number[], w: WrittenNumber): boolean {
  const target = Math.abs(w.value);
  const same = (v: number) =>
    Math.abs(Number(Math.abs(v).toFixed(w.decimals)) - target) < 1e-9;
  return values.some((v) => same(v) || (w.percent && same(v * 100)));
}

const ok = (
  c: ToolCall | undefined,
): c is ToolCall & {
  outcome: Extract<ToolOutcome, { ok: true }>;
} => c?.outcome.ok === true;

/**
 * Check an answer against the calls of its session (D3). Deterministic: the
 * same answer and calls always give the same verdict.
 */
export function checkAnswer(
  answer: SubmittedAnswer,
  calls: readonly ToolCall[],
  asOf: string,
): AnswerCheck {
  const byId = new Map(calls.map((c) => [c.id, c]));
  const problems: string[] = [];
  for (const w of numbersIn(answer.summary))
    if (
      !answer.claims.some((c) =>
        numbersIn(c.statement).some((x) => x.value === w.value),
      )
    )
      problems.push(
        `the summary states ${w.text}, which no claim states — put it in a claim that cites its evidence`,
      );

  const claims = answer.claims.map((claim, index): ClaimCheck => {
    const out: string[] = [];
    const cited = claim.cites.map((id) => byId.get(id));
    claim.cites.forEach((id, i) => {
      const c = cited[i];
      if (c === undefined)
        out.push(`cites ${id}, which is no call of this session`);
      else if (!c.outcome.ok) out.push(`cites ${id}, which failed`);
    });
    const good = cited.filter(ok);
    const evidence = good.filter((c) => c.outcome.evidence);
    const numbers = numbersIn(claim.statement);
    const dates = [...claim.statement.matchAll(DATE)].map((m) => m[0]);

    if (numbers.length > 0 && evidence.length === 0)
      out.push(
        "states a number but cites no evidence tool — research search is memory, not evidence (§9.2)",
      );
    const values = evidence.flatMap((c) => numbersOf(c.outcome));
    for (const w of numbers)
      if (evidence.length > 0 && !holds(values, w))
        out.push(`states ${w.text}, which is in none of the results it cites`);

    for (const d of dates) {
      if (d > asOf) {
        out.push(`states ${d}, after asOf ${asOf}`);
        continue;
      }
      const covered = good.some(
        (c) =>
          JSON.stringify(c.outcome).includes(d) ||
          (c.outcome.provenance.range !== null &&
            c.outcome.provenance.range.fromDate <= d &&
            d <= c.outcome.provenance.range.toDate),
      );
      if (!covered)
        out.push(`states ${d}, which none of the results it cites covers`);
    }
    for (const c of good)
      if (
        c.outcome.evidence &&
        c.outcome.provenance.range === null &&
        numbers.length > 0
      )
        out.push(
          `cites ${c.id}, which read nothing (no sessions in range) — it cannot carry a number`,
        );
    return { index, statement: claim.statement, problems: out };
  });
  return {
    ok: problems.length === 0 && claims.every((c) => c.problems.length === 0),
    claims,
    problems,
  };
}

/** The reasons, for the model to correct its answer by. */
export function rejection(check: AnswerCheck): string {
  return [
    "The answer was rejected. Fix every problem and submit again; drop a claim the evidence does not support.",
    ...check.problems.map((p) => `- answer: ${p}`),
    ...check.claims.flatMap((c) =>
      c.problems.map(
        (p) => `- claim ${String(c.index + 1)} ("${c.statement}"): ${p}`,
      ),
    ),
  ].join("\n");
}

const list = (xs: readonly string[] | undefined): string =>
  xs === undefined || xs.length === 0 ? "—" : xs.join(", ");

/** The context of one cited call, in words — written by code, never by the model (D4). */
export function contextOf(call: ToolCall): string {
  if (!call.outcome.ok)
    return `${call.id} ${call.name}: failed — ${call.outcome.error}`;
  const p: ToolProvenance = call.outcome.provenance;
  const parts = [
    `${call.id} ${call.name}${call.outcome.evidence ? "" : " (memory, not evidence)"}`,
    `n = ${String(p.n)}`,
    p.range === null
      ? "no sessions read"
      : `sessions ${p.range.fromDate} .. ${p.range.toDate}`,
    `as of ${p.asOf ?? "—"}`,
    ...Object.entries(p.versions)
      .filter(([, v]) => v.length > 0)
      .map(([k, v]) => `${k} ${v.join(", ")}`),
  ];
  if (p.data !== undefined)
    parts.push(
      `data: ${list(p.data.sources)}, ingestion ${list(p.data.ingestionVersions.map(String))}`,
    );
  if (p.costs !== undefined && p.costs.length > 0)
    parts.push(
      `costs: ${p.costs
        .map(
          (c) =>
            `slippage ${JSON.stringify(c.slippage)}, charges ${JSON.stringify(c.transactionCost)}`,
        )
        .join("; ")}`,
    );
  return parts.join("; ");
}

export type Verdict = "SUPPORTED" | "UNSUPPORTED";

/**
 * The answer the operator reads (D4): the summary, each claim followed by the
 * context of every call it cites, the caveats, and the checker's verdict.
 */
export function renderAnswer(
  answer: SubmittedAnswer,
  calls: readonly ToolCall[],
  check: AnswerCheck,
): string {
  const byId = new Map(calls.map((c) => [c.id, c]));
  const verdict: Verdict = check.ok ? "SUPPORTED" : "UNSUPPORTED";
  const lines = [answer.summary, ""];
  answer.claims.forEach((claim, i) => {
    lines.push(`${String(i + 1)}. ${claim.statement}`);
    for (const id of claim.cites) {
      const c = byId.get(id);
      lines.push(
        `   [${c === undefined ? `${id}: no such call` : contextOf(c)}]`,
      );
    }
  });
  if (answer.claims.length === 0)
    lines.push("No finding: the evidence does not answer this.");
  if (answer.caveats.length > 0) {
    lines.push("", "Caveats:");
    for (const c of answer.caveats) lines.push(`- ${c}`);
  }
  lines.push(
    "",
    check.ok
      ? `${verdict}: every number and date is in the evidence it cites.`
      : `${verdict}:\n${rejection(check).split("\n").slice(1).join("\n")}`,
  );
  return lines.join("\n");
}
