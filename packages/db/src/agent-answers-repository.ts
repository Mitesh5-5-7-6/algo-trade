import type { Db } from "mongodb";
import { z } from "zod";
import { COLLECTIONS } from "./collections.js";

/**
 * One research question, answered (Phase 11 D7): what was asked and as of
 * when, by which model and agent versions, every tool call with its input and
 * outcome, the answer, the checker's verdict and the text the operator read.
 * Kept as the agent produced it, so an answer can be audited — re-checked and
 * re-rendered — without calling the model again.
 */
export const AgentAnswerDocSchema = z.object({
  answerId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  question: z.string().min(1),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  model: z.string().min(1),
  servedBy: z.array(z.string()),
  versions: z.record(z.string(), z.string()),
  status: z.enum(["ANSWERED", "REFUSED", "TRUNCATED", "EXHAUSTED"]),
  verdict: z.enum(["SUPPORTED", "UNSUPPORTED"]),
  corrections: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  usage: z.object({ input: z.number(), output: z.number() }),
  calls: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      input: z.unknown(),
      outcome: z.record(z.string(), z.unknown()),
    }),
  ),
  answer: z.record(z.string(), z.unknown()).nullable(),
  check: z.record(z.string(), z.unknown()).nullable(),
  rendered: z.string(),
  /**
   * What the answer's proposals were checked against (Phase 12 D3) — the
   * detectors, replayable strategies and instruments; null when proposals
   * could not be made, absent on answers kept before Phase 12.
   */
  catalog: z
    .object({
      patterns: z.array(z.string()),
      strategies: z.array(z.string()),
      symbols: z.array(z.string()),
    })
    .nullable()
    .optional(),
  /** sha256 of everything above except the id and the creation time. */
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AgentAnswerDoc = z.infer<typeof AgentAnswerDocSchema>;

/** `agent_answers` — research analyses, untimed, never edited (ADR §10.4). */
export class AgentAnswersRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.agentAnswers);
  }

  /** Keep an answer. Never overwrites: false when its id exists. */
  async save(answer: AgentAnswerDoc): Promise<boolean> {
    const doc = AgentAnswerDocSchema.parse(answer);
    const result = await this.collection.updateOne(
      { answerId: doc.answerId },
      { $setOnInsert: doc },
      { upsert: true },
    );
    return result.upsertedCount > 0;
  }

  async findById(answerId: string): Promise<AgentAnswerDoc | null> {
    const doc = await this.collection.findOne(
      { answerId },
      { projection: { _id: 0 } },
    );
    return doc === null ? null : AgentAnswerDocSchema.parse(doc);
  }

  /** The newest answers, newest first. */
  async recent(limit: number): Promise<AgentAnswerDoc[]> {
    const docs = await this.collection
      .find({}, { projection: { _id: 0 } })
      .sort({ createdAt: -1, answerId: 1 })
      .limit(Math.min(Math.max(1, limit), 200))
      .toArray();
    return docs.map((d) => AgentAnswerDocSchema.parse(d));
  }
}
