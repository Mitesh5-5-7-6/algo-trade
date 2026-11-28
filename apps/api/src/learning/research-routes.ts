import type { Db } from "mongodb";
import { istDateKey, startOfDayIST } from "@neelkanth/core";
import { LessonsRepository } from "@neelkanth/db";
import type { ApiServer } from "../server.js";
import { NotFoundError, UnauthorizedError } from "../errors.js";
import { runLearner } from "./run-learner.js";

/**
 * The research service's side of the learning system (PLAN.md 14.27): the
 * judged lessons, served to the trading API, and the judge run every weekday
 * after the close. Research database only.
 */
export function registerLessonResearchRoutes(
  app: ApiServer,
  deps: { db: Db; token: string },
): void {
  const repo = new LessonsRepository(deps.db);
  const authorize = (header: string | undefined) => {
    if (header !== `Bearer ${deps.token}`)
      throw new UnauthorizedError("a valid bearer token is required");
  };

  app.get("/lessons", async (request) => {
    authorize(request.headers.authorization);
    return { lessons: await repo.findAll() };
  });

  app.get("/lessons/:id", async (request) => {
    authorize(request.headers.authorization);
    const { id } = request.params as { id: string };
    const lesson = await repo.findById(id);
    if (lesson === null) throw new NotFoundError("lesson not found", { id });
    return lesson;
  });
}

/** 16:45 IST, after the close and the day's last bars are stored. */
export const LEARNER_MINUTE = 16 * 60 + 45;

/**
 * Runs the judge once each weekday at or after 16:45 IST — and once at start,
 * so a fresh deploy has verdicts without waiting a day. One run at a time;
 * a failure is reported and retried at the next day's slot.
 */
export class LearnerScheduler {
  private lastDay = "";
  private running = false;
  private startedOnce = false;

  constructor(
    private readonly deps: {
      db: Db;
      onError: (error: unknown, context: Record<string, unknown>) => void;
      onRun?: (summary: {
        lessons: number;
        passed: number;
        coverage: string[];
      }) => void;
    },
  ) {}

  async tick(now: number): Promise<void> {
    if (this.running) return;
    const day = istDateKey(now);
    const weekday = new Date(startOfDayIST(now) + 12 * 3_600_000).getUTCDay();
    const due =
      !this.startedOnce ||
      (this.lastDay !== day &&
        weekday >= 1 &&
        weekday <= 5 &&
        now - startOfDayIST(now) >= LEARNER_MINUTE * 60_000);
    if (!due) return;
    this.running = true;
    this.startedOnce = true;
    this.lastDay = day;
    try {
      const result = await runLearner(this.deps.db, now, { save: true });
      this.deps.onRun?.({
        lessons: result.lessons.length,
        passed: result.lessons.filter((l) => l.verdict === "PASSED").length,
        coverage: result.coverage,
      });
    } catch (error) {
      this.deps.onError(error, { where: "LearnerScheduler.tick" });
    } finally {
      this.running = false;
    }
  }
}
