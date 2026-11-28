import { istDateKey, isWeekendIST, minuteOfDayIST } from "@neelkanth/core";
import type { ErrorSink } from "./collector.js";

/**
 * When each news job runs (operator decision 2026-11-28), as clock-aligned
 * slots in IST — the same idea as the option-chain archiver: a slot is spent
 * when it is tried, so a failure waits for the next slot instead of being
 * retried every minute, and a job still running is never started twice.
 *
 *   general        every 10 min 07:00-16:00 on weekdays, hourly otherwise
 *   heavyweights   every 30 min 07:00-16:00 on weekdays (Google News)
 *   overnight      once a weekday, from 08:00 (Yahoo; a later start catches up)
 *   morningRead    once a weekday, from 08:40 until 15:30 (skipped by the job
 *                  when the date already has a read, so a restart re-reads nothing)
 */
export const JOBS = [
  "general",
  "heavyweights",
  "overnight",
  "morningRead",
] as const;
export type JobName = (typeof JOBS)[number];

const MARKET_FROM = 7 * 60;
const MARKET_TO = 16 * 60;
const OVERNIGHT_FROM = 8 * 60;
const READ_FROM = 8 * 60 + 40;
const READ_TO = 15 * 60 + 30;

/** The slot a job is in at `now`, or null when it does not run then. */
export function slotFor(job: JobName, now: number): string | null {
  const date = istDateKey(now);
  const minute = minuteOfDayIST(now);
  const weekday = !isWeekendIST(date);
  const hours = weekday && minute >= MARKET_FROM && minute < MARKET_TO;
  switch (job) {
    case "general":
      return hours
        ? `general:${date}:m${String(Math.floor(minute / 10) * 10)}`
        : `general:${date}:h${String(Math.floor(minute / 60))}`;
    case "heavyweights":
      return hours
        ? `heavyweights:${date}:m${String(Math.floor(minute / 30) * 30)}`
        : null;
    case "overnight":
      return weekday && minute >= OVERNIGHT_FROM ? `overnight:${date}` : null;
    case "morningRead":
      return weekday && minute >= READ_FROM && minute < READ_TO
        ? `morningRead:${date}`
        : null;
  }
}

export interface SchedulerDeps {
  jobs: Record<JobName, () => Promise<void>>;
  now: () => number;
  onError: ErrorSink;
  tickMs?: number;
}

/** One minute tick, one attempt per job per slot. */
export class NewsScheduler {
  private readonly lastSlot = new Map<JobName, string>();
  private readonly inFlight = new Set<JobName>();
  private timer: NodeJS.Timeout | null = null;
  private aligner: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps) {}

  /** Starts the jobs due in this tick; resolves when they have finished. */
  async tick(now = this.deps.now()): Promise<void> {
    const started: Promise<void>[] = [];
    for (const job of JOBS) {
      if (this.stopped) break;
      const slot = slotFor(job, now);
      if (slot === null || this.lastSlot.get(job) === slot) continue;
      if (this.inFlight.has(job)) continue;
      this.lastSlot.set(job, slot);
      this.inFlight.add(job);
      started.push(
        this.deps.jobs[job]()
          .catch((error: unknown) => {
            this.deps.onError(error, { where: "newsScheduler", job, slot });
          })
          .finally(() => {
            this.inFlight.delete(job);
          }),
      );
    }
    await Promise.all(started);
  }

  /** Ticks now, then on each minute boundary. */
  start(): void {
    if (this.timer !== null || this.aligner !== null) return;
    this.stopped = false;
    const tickMs = this.deps.tickMs ?? 60_000;
    const fire = () => {
      void this.tick();
    };
    fire();
    this.aligner = setTimeout(
      () => {
        this.aligner = null;
        fire();
        this.timer = setInterval(fire, tickMs);
        this.timer.unref();
      },
      tickMs - (this.deps.now() % tickMs),
    );
    this.aligner.unref();
  }

  /** No new attempts; one already running finishes on its own. */
  stop(): void {
    this.stopped = true;
    if (this.aligner !== null) clearTimeout(this.aligner);
    if (this.timer !== null) clearInterval(this.timer);
    this.aligner = null;
    this.timer = null;
  }

  get isStopped(): boolean {
    return this.stopped;
  }
}
