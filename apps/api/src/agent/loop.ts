import type Anthropic from "@anthropic-ai/sdk";
import {
  ANSWER_CONTRACT_VERSION,
  checkAnswer,
  rejection,
  renderAnswer,
  SUBMIT_ANSWER_TOOL,
  SubmittedAnswerSchema,
  type AnswerCheck,
  type SubmittedAnswer,
  type ToolCall,
  type Verdict,
} from "./answer.js";
import type { ResearchModel } from "./model.js";
import {
  AGENT_TOOLS,
  AGENT_TOOLS_VERSION,
  toolNamed,
  type ToolContext,
} from "./tools.js";

/** Bumped whenever the loop's prompt or bounds change (D6). */
export const AGENT_LOOP_VERSION = "1";

export const MAX_TURNS = 12;
export const MAX_CORRECTIONS = 2;

/**
 * How a session ended. ANSWERED — an answer was submitted (and its verdict
 * says whether it was supported). REFUSED — the model declined. TRUNCATED — a
 * turn was cut off. EXHAUSTED — no answer within MAX_TURNS.
 */
export type SessionStatus = "ANSWERED" | "REFUSED" | "TRUNCATED" | "EXHAUSTED";

export interface ResearchSession {
  question: string;
  asOf: string;
  model: string;
  /** Every model that served a turn — another when a refusal fell back. */
  servedBy: string[];
  versions: { tools: string; answerContract: string; loop: string };
  calls: ToolCall[];
  answer: SubmittedAnswer | null;
  check: AnswerCheck | null;
  status: SessionStatus;
  verdict: Verdict;
  corrections: number;
  turns: number;
  usage: { input: number; output: number };
  /** What the operator reads — rendered by code (D4). */
  rendered: string;
}

/**
 * The instructions, the same for every session so the prefix caches; the
 * question and its asOf come in the first user message.
 */
export const SYSTEM_PROMPT = `You are the research analyst of an algorithmic-trading research system for Indian index markets (NIFTY, BANKNIFTY). You answer questions from the system's own research — replayed strategies, the patterns they met, completed Trades and their outcomes, counterfactual runs and tested hypotheses — and from nothing else.

How you work:
- Answer only from what the tools return. Before you state a number, a tool result you cite must hold it. Your own knowledge of markets is not evidence here.
- Every tool result is labelled with a call id (c1, c2, …). Cite those ids.
- search_research is memory: use it to find what to look at, then answer with the evidence tools (find_patterns, trade_history, strategy_matrix, experiment_history, similar_sessions).
- Say how much evidence there is. A result with few Trades, or one regime only, decides little — say so in a caveat rather than generalise.
- Every question is asked as of a date. Nothing after it exists for you; the tools enforce it.
- There is no news tool, no backtest and no walk-forward: those are not built. If a question needs them, say that the evidence does not exist.
- You cannot trade, place or change orders, or change any limit or setting, and no tool does. If asked to, say so and answer only what research can.

Finish by calling submit_answer: a short summary, the claims — each one sentence citing the call ids it rests on — and the caveats. A checker verifies every number and date in each claim against the results it cites; if it rejects the answer, fix exactly what it names and submit again. A claim the evidence does not support is to be dropped, not reworded.`;

const RESEARCH_TOOLS = AGENT_TOOLS.map((t) => t.definition);

/**
 * Ask one research question (D3, D6): the model calls the tools, each call
 * run as of the session's date and recorded; the session ends when an answer
 * is submitted and checked — corrected at most MAX_CORRECTIONS times — or the
 * model refuses, a turn is cut off, or MAX_TURNS pass.
 */
export async function runResearch(
  question: string,
  ctx: ToolContext,
  model: ResearchModel,
  options: { maxTurns?: number; maxCorrections?: number } = {},
): Promise<ResearchSession> {
  const maxTurns = options.maxTurns ?? MAX_TURNS;
  const maxCorrections = options.maxCorrections ?? MAX_CORRECTIONS;
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `As of ${ctx.asOf}: ${question}`,
    },
  ];
  const calls: ToolCall[] = [];
  const servedBy = new Set<string>();
  const usage = { input: 0, output: 0 };
  let corrections = 0;
  let turns = 0;
  let last: { answer: SubmittedAnswer; check: AnswerCheck } | null = null;

  const end = (status: SessionStatus, note?: string): ResearchSession => {
    const verdict: Verdict =
      status === "ANSWERED" && last?.check.ok === true
        ? "SUPPORTED"
        : "UNSUPPORTED";
    const rendered =
      last === null
        ? `UNSUPPORTED: no answer — ${note ?? status}.`
        : renderAnswer(last.answer, calls, last.check) +
          (status === "ANSWERED" ? "" : `\n(${note ?? status})`);
    return {
      question,
      asOf: ctx.asOf,
      model: model.id,
      servedBy: [...servedBy].sort(),
      versions: {
        tools: AGENT_TOOLS_VERSION,
        answerContract: ANSWER_CONTRACT_VERSION,
        loop: AGENT_LOOP_VERSION,
      },
      calls,
      answer: last?.answer ?? null,
      check: last?.check ?? null,
      status,
      verdict,
      corrections,
      turns,
      usage,
      rendered,
    };
  };

  while (turns < maxTurns) {
    turns += 1;
    const turn = await model.turn({
      system: SYSTEM_PROMPT,
      messages,
      tools: [...RESEARCH_TOOLS, SUBMIT_ANSWER_TOOL],
    });
    servedBy.add(turn.servedBy);
    usage.input += turn.usage.input;
    usage.output += turn.usage.output;
    // A refusal or a cut-off turn may hold a partial tool call: none is run.
    if (turn.stopReason === "refusal")
      return end("REFUSED", "the model declined the question");
    if (
      turn.stopReason === "max_tokens" ||
      turn.stopReason === "model_context_window_exceeded"
    )
      return end("TRUNCATED", `a turn was cut off (${turn.stopReason})`);
    messages.push({ role: "assistant", content: turn.content });

    const uses = turn.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
    );
    if (uses.length === 0) {
      messages.push({
        role: "user",
        content:
          "Finish by calling submit_answer, with claims citing the call ids they rest on — or call a tool if you need more evidence.",
      });
      continue;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    // Research tools first: a submit in the same turn may cite them.
    const submits = uses.filter((u) => u.name === SUBMIT_ANSWER_TOOL.name);
    for (const use of uses.filter((u) => u.name !== SUBMIT_ANSWER_TOOL.name)) {
      const tool = toolNamed(use.name);
      const id = `c${String(calls.length + 1)}`;
      const outcome =
        tool === undefined
          ? {
              ok: false as const,
              error: `there is no tool ${use.name}; the tools are ${RESEARCH_TOOLS.map((t) => t.name).join(", ")}`,
            }
          : await tool.run(use.input, ctx);
      calls.push({ id, name: use.name, input: use.input, outcome });
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        is_error: !outcome.ok,
        content: JSON.stringify({ call: id, ...outcome }),
      });
    }

    let accepted = false;
    for (const use of submits) {
      const parsed = SubmittedAnswerSchema.safeParse(use.input);
      if (!parsed.success) {
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content: `submit_answer input is invalid: ${parsed.error.message}`,
        });
        continue;
      }
      const check = checkAnswer(parsed.data, calls, ctx.asOf);
      last = { answer: parsed.data, check };
      if (check.ok) {
        accepted = true;
        break;
      }
      if (corrections >= maxCorrections) return end("ANSWERED");
      corrections += 1;
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        is_error: true,
        content: rejection(check),
      });
    }
    if (accepted) return end("ANSWERED");
    messages.push({ role: "user", content: results });
  }
  return end(
    "EXHAUSTED",
    `no supported answer within ${String(maxTurns)} turns`,
  );
}
