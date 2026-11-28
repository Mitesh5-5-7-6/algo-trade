import type { Db } from "mongodb";
import {
  AppliedLessonSchema,
  LessonSchema,
  SignalContextSchema,
  type AppliedLesson,
  type Lesson,
  type SignalContext,
} from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

/**
 * The lessons the judge tested (PLAN.md 14.27) — RESEARCH database. One row
 * per lesson, replaced by each run: the dashboard shows the latest verdict,
 * and the verdict carries the dates and costs it was reached on.
 */
export class LessonsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.lessons);
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ lessonId: 1 }, { unique: true });
    await this.collection.createIndex({ verdict: 1, judgedAt: -1 });
  }

  async upsert(lesson: Lesson): Promise<void> {
    const doc = LessonSchema.parse(lesson);
    await this.collection.replaceOne({ lessonId: doc.lessonId }, doc, {
      upsert: true,
    });
  }

  async findAll(): Promise<Lesson[]> {
    const docs = await this.collection
      .find({}, { projection: { _id: 0 } })
      .sort({ verdict: 1, judgedAt: -1 })
      .toArray();
    return docs.map((d) => LessonSchema.parse(d));
  }

  async findById(lessonId: string): Promise<Lesson | null> {
    const doc = await this.collection.findOne(
      { lessonId },
      { projection: { _id: 0 } },
    );
    return doc === null ? null : LessonSchema.parse(doc);
  }
}

/**
 * Lessons the operator applied to paper (PLAN.md 14.28) — PAPER database.
 * Applying and stopping are the operator's, behind step-up; a stopped lesson
 * keeps its row, so what was in force on any day can be read back.
 */
export class AppliedLessonsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.appliedLessons);
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ lessonId: 1 }, { unique: true });
    await this.collection.createIndex({ status: 1 });
  }

  /** Apply (or re-apply) a lesson. */
  async apply(lesson: AppliedLesson): Promise<void> {
    const doc = AppliedLessonSchema.parse(lesson);
    await this.collection.replaceOne({ lessonId: doc.lessonId }, doc, {
      upsert: true,
    });
  }

  /** Stop a lesson; false when it was not active. */
  async stop(lessonId: string, at: number): Promise<boolean> {
    const result = await this.collection.updateOne(
      { lessonId, status: "ACTIVE" },
      { $set: { status: "STOPPED", stoppedAt: at } },
    );
    return result.modifiedCount === 1;
  }

  async findAll(): Promise<AppliedLesson[]> {
    const docs = await this.collection
      .find({}, { projection: { _id: 0 } })
      .sort({ appliedAt: -1 })
      .toArray();
    return docs.map((d) => AppliedLessonSchema.parse(d));
  }

  async findActive(): Promise<AppliedLesson[]> {
    const docs = await this.collection
      .find({ status: "ACTIVE" }, { projection: { _id: 0 } })
      .toArray();
    return docs.map((d) => AppliedLessonSchema.parse(d));
  }
}

/**
 * Every signal's conditions when it fired (PLAN.md 14.26) — PAPER database.
 * Kept for every entry signal, taken or blocked, so the learner can later
 * ask what the conditions were on the trades that won and the ones that lost.
 */
export class SignalContextsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.signalContexts);
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ signalId: 1 }, { unique: true });
    await this.collection.createIndex({ ts: -1 });
  }

  /** Keep a signal's context; a repeat of the same signal is ignored. */
  async insert(context: SignalContext): Promise<void> {
    const doc = SignalContextSchema.parse(context);
    await this.collection.updateOne(
      { signalId: doc.signalId },
      { $setOnInsert: doc },
      { upsert: true },
    );
  }

  async findRange(from: number, to: number): Promise<SignalContext[]> {
    const docs = await this.collection
      .find({ ts: { $gte: from, $lt: to } }, { projection: { _id: 0 } })
      .sort({ ts: 1 })
      .toArray();
    return docs.map((d) => SignalContextSchema.parse(d));
  }

  async findBySignalIds(ids: readonly string[]): Promise<SignalContext[]> {
    const docs = await this.collection
      .find({ signalId: { $in: [...ids] } }, { projection: { _id: 0 } })
      .toArray();
    return docs.map((d) => SignalContextSchema.parse(d));
  }
}
