import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { canonicalJson } from "@neelkanth/core";
import { AgentAnswersRepository, type AgentAnswerDoc } from "@neelkanth/db";
import {
  checkAnswer,
  renderAnswer,
  SubmittedAnswerSchema,
  type ToolCall,
} from "./answer.js";
import { proposalCatalog } from "./catalog.js";
import type { ResearchSession } from "./loop.js";

/** A session as kept (D7): everything it did, fingerprinted. */
export function answerDoc(
  session: ResearchSession,
  createdAt: number,
): AgentAnswerDoc {
  const body = {
    question: session.question,
    asOf: session.asOf,
    model: session.model,
    servedBy: session.servedBy,
    versions: session.versions,
    status: session.status,
    verdict: session.verdict,
    corrections: session.corrections,
    turns: session.turns,
    usage: session.usage,
    calls: session.calls.map((c) => ({
      id: c.id,
      name: c.name,
      input: c.input,
      outcome: c.outcome,
    })),
    answer: session.answer as Record<string, unknown> | null,
    check: session.check as unknown as Record<string, unknown> | null,
    rendered: session.rendered,
    catalog: session.catalog,
  };
  const fingerprint = createHash("sha256")
    .update(canonicalJson(body))
    .digest("hex");
  return {
    answerId: `ans_${String(createdAt)}_${fingerprint.slice(0, 12)}`,
    createdAt,
    ...body,
    fingerprint,
  };
}

/** Keep a session in `agent_answers`, never edited (D7). */
export async function keepSession(
  db: Db,
  session: ResearchSession,
  createdAt: number,
): Promise<AgentAnswerDoc> {
  const doc = answerDoc(session, createdAt);
  if (!(await new AgentAnswersRepository(db).save(doc)))
    throw new Error(
      `${doc.answerId} is already kept; an answer is never edited`,
    );
  return doc;
}

export interface Audit {
  answerId: string;
  /** The fingerprint still matches what was kept. */
  intact: boolean;
  /** Re-checking the kept answer against the kept calls gives the kept verdict. */
  verdictHolds: boolean;
  /** Re-rendering gives the text the operator read. */
  renderedHolds: boolean;
}

/**
 * Audit a kept answer without the model (D7): the fingerprint, the verdict
 * re-checked from the kept answer and calls, the text re-rendered.
 */
export function auditAnswer(doc: AgentAnswerDoc): Audit {
  const { answerId, fingerprint } = doc;
  const body = Object.fromEntries(
    Object.entries(doc).filter(
      ([k]) => !["answerId", "createdAt", "fingerprint"].includes(k),
    ),
  );
  const intact =
    createHash("sha256").update(canonicalJson(body)).digest("hex") ===
    fingerprint;
  const calls = doc.calls as unknown as ToolCall[];
  const parsed =
    doc.answer === null ? null : SubmittedAnswerSchema.safeParse(doc.answer);
  if (parsed === null || !parsed.success)
    return {
      answerId,
      intact,
      verdictHolds: doc.verdict === "UNSUPPORTED",
      renderedHolds: doc.answer === null,
    };
  // Proposals are re-checked against the catalog they were checked against,
  // each variant through its strategy's own schema as the code holds it now.
  const catalog =
    doc.catalog === undefined || doc.catalog === null
      ? undefined
      : {
          ...doc.catalog,
          checkParams: proposalCatalog(doc.catalog.symbols).checkParams,
        };
  const check = checkAnswer(parsed.data, calls, doc.asOf, catalog);
  const supported = doc.status === "ANSWERED" && check.ok;
  return {
    answerId,
    intact,
    verdictHolds: (supported ? "SUPPORTED" : "UNSUPPORTED") === doc.verdict,
    renderedHolds: doc.rendered.startsWith(
      renderAnswer(parsed.data, calls, check),
    ),
  };
}
