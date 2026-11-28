import { z } from "zod";
import type { Db } from "mongodb";
import { LessonSchema, type AppliedLesson, type Lesson } from "@neelkanth/core";
import {
  AppliedLessonsRepository,
  COLLECTIONS,
  SignalContextsRepository,
} from "@neelkanth/db";
import type { ApiServer } from "../server.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { StepUpVerifier } from "../control-plane/controls.js";
import type { ResearchService } from "../control-plane/research-relay.js";

export interface LessonRouteDeps {
  /** The PAPER database: applied lessons, signal contexts, trades. */
  db: Db;
  verifyStepUp: StepUpVerifier;
  /** Where the judged lessons live; null when no research service is configured. */
  research: ResearchService | null;
  fetch?: typeof fetch;
  now?: () => number;
}

const StepUpBody = z.object({ stepUpPassword: z.string().optional() });

/** What an applied lesson has done in paper since it was applied. */
export interface LessonForward {
  /** Entry signals it judged. */
  judged: number;
  blocked: number;
  passed: number;
  /** Passed signals that became trades, and how those trades ended. */
  traded: number;
  closed: number;
  wins: number;
  netPnl: number;
}

/**
 * The Lessons page's API (PLAN.md 14.28, operator decision 2026-11-28,
 * option A): the judged lessons from the research service, the lessons the
 * operator applied to paper, and what each applied lesson has done since.
 * Applying and stopping are the operator's alone, behind the step-up
 * password, and only a lesson the judge PASSED can be applied.
 */
export function registerLessonRoutes(
  app: ApiServer,
  deps: LessonRouteDeps,
): void {
  const applied = new AppliedLessonsRepository(deps.db);
  const contexts = new SignalContextsRepository(deps.db);
  const send = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Date.now());

  const fromResearch = async (path: string): Promise<unknown> => {
    if (deps.research === null)
      throw new Error(
        "the research service is not configured for this deployment",
      );
    const response = await send(new URL(path, deps.research.url), {
      headers: { authorization: `Bearer ${deps.research.token}` },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (response.status === 404) return null;
    if (response.status !== 200)
      throw new Error(
        `the research service answered ${String(response.status)}: ${text.slice(0, 160)}`,
      );
    return JSON.parse(text) as unknown;
  };

  const forwardOf = async (lesson: AppliedLesson): Promise<LessonForward> => {
    const since = lesson.appliedAt;
    const until = lesson.stoppedAt ?? now() + 1;
    const rows = (await contexts.findRange(since, until)).filter((c) =>
      c.lessons.some((l) => l.lessonId === lesson.lessonId),
    );
    const judgement = (signalId: string) =>
      rows
        .find((r) => r.signalId === signalId)
        ?.lessons.find((l) => l.lessonId === lesson.lessonId)?.judgement;
    const passedIds = new Set(
      rows
        .filter((r) => judgement(r.signalId) === "pass")
        .map((r) => r.signalId),
    );
    // Only the three fields this needs: the signal a trade came from and how it ended.
    const taken = (await deps.db
      .collection(COLLECTIONS.trades)
      .find(
        {
          entryTime: { $gte: since, $lt: until },
          entrySignalId: { $in: [...passedIds] },
        },
        { projection: { _id: 0, entrySignalId: 1, netPnl: 1 } },
      )
      .toArray()) as unknown as Array<{
      entrySignalId: string;
      netPnl?: number;
    }>;
    const closed = taken.filter((t) => t.netPnl !== undefined);
    return {
      judged: rows.length,
      blocked: rows.filter((r) => judgement(r.signalId) === "block").length,
      passed: passedIds.size,
      traded: taken.length,
      closed: closed.length,
      wins: closed.filter((t) => (t.netPnl ?? 0) > 0).length,
      netPnl: closed.reduce((s, t) => s + (t.netPnl ?? 0), 0),
    };
  };

  app.get("/lessons", async () => {
    let lessons: Lesson[] = [];
    let researchError: string | null = null;
    try {
      const body = (await fromResearch("/lessons")) as {
        lessons?: unknown;
      } | null;
      lessons = z.array(LessonSchema).parse(body?.lessons ?? []);
    } catch (error) {
      researchError = error instanceof Error ? error.message : String(error);
    }
    const appliedRows = await applied.findAll();
    return {
      lessons,
      researchError,
      applied: await Promise.all(
        appliedRows.map(async (a) => ({ ...a, forward: await forwardOf(a) })),
      ),
    };
  });

  // ⚠ step-up: changes what paper trades.
  app.post("/lessons/:id/apply", async (request) => {
    const { id } = request.params as { id: string };
    const body = StepUpBody.parse(request.body ?? {});
    await deps.verifyStepUp(request.authUser?.userId, body.stepUpPassword);
    const found = await fromResearch(`/lessons/${encodeURIComponent(id)}`);
    if (found === null) throw new NotFoundError("lesson not found", { id });
    const lesson = LessonSchema.parse(found);
    if (lesson.verdict !== "PASSED")
      throw new ValidationError(
        `only a lesson that passed its test can be applied; this one is ${lesson.verdict}`,
        { id, verdict: lesson.verdict },
      );
    const row: AppliedLesson = {
      lessonId: lesson.lessonId,
      scope: lesson.scope,
      condition: lesson.condition,
      summary: lesson.summary,
      status: "ACTIVE",
      appliedAt: now(),
      appliedBy: request.authUser?.userId ?? "operator",
      promised: { test: lesson.test, pValue: lesson.pValue },
    };
    await applied.apply(row);
    return row;
  });

  // ⚠ step-up, like applying: stopping changes what paper trades too.
  app.post("/lessons/:id/stop", async (request) => {
    const { id } = request.params as { id: string };
    const body = StepUpBody.parse(request.body ?? {});
    await deps.verifyStepUp(request.authUser?.userId, body.stepUpPassword);
    const stopped = await applied.stop(id, now());
    if (!stopped)
      throw new NotFoundError("no active lesson with this id", { id });
    return { lessonId: id, status: "STOPPED" };
  });
}
