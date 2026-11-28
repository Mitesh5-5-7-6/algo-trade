import { describe, expect, it } from "vitest";
import { JOBS, NewsScheduler, slotFor, type JobName } from "./scheduler.js";

/** An IST wall-clock time as epoch ms. */
const ist = (date: string, hhmm: string): number =>
  Date.parse(`${date}T${hhmm}:00+05:30`);
const MONDAY = "2026-11-30";
const SATURDAY = "2026-11-28";

describe("slotFor — clock-aligned IST slots", () => {
  it("general feeds: every 10 minutes 07:00-16:00 on a weekday, hourly otherwise", () => {
    expect(slotFor("general", ist(MONDAY, "07:00"))).toBe(
      `general:${MONDAY}:m420`,
    );
    expect(slotFor("general", ist(MONDAY, "07:09"))).toBe(
      `general:${MONDAY}:m420`,
    );
    expect(slotFor("general", ist(MONDAY, "07:10"))).toBe(
      `general:${MONDAY}:m430`,
    );
    expect(slotFor("general", ist(MONDAY, "15:59"))).toBe(
      `general:${MONDAY}:m950`,
    );
    expect(slotFor("general", ist(MONDAY, "16:00"))).toBe(
      `general:${MONDAY}:h16`,
    );
    expect(slotFor("general", ist(MONDAY, "16:59"))).toBe(
      `general:${MONDAY}:h16`,
    );
    expect(slotFor("general", ist(MONDAY, "06:59"))).toBe(
      `general:${MONDAY}:h6`,
    );
    expect(slotFor("general", ist(SATURDAY, "10:15"))).toBe(
      `general:${SATURDAY}:h10`,
    );
  });

  it("heavyweight queries: every 30 minutes 07:00-16:00 on a weekday, never otherwise", () => {
    expect(slotFor("heavyweights", ist(MONDAY, "07:00"))).toBe(
      `heavyweights:${MONDAY}:m420`,
    );
    expect(slotFor("heavyweights", ist(MONDAY, "07:29"))).toBe(
      `heavyweights:${MONDAY}:m420`,
    );
    expect(slotFor("heavyweights", ist(MONDAY, "07:30"))).toBe(
      `heavyweights:${MONDAY}:m450`,
    );
    expect(slotFor("heavyweights", ist(MONDAY, "16:00"))).toBeNull();
    expect(slotFor("heavyweights", ist(MONDAY, "06:30"))).toBeNull();
    expect(slotFor("heavyweights", ist(SATURDAY, "10:00"))).toBeNull();
  });

  it("overnight from 08:00 and the morning read from 08:40, once a weekday", () => {
    expect(slotFor("overnight", ist(MONDAY, "07:59"))).toBeNull();
    expect(slotFor("overnight", ist(MONDAY, "08:00"))).toBe(
      `overnight:${MONDAY}`,
    );
    expect(slotFor("overnight", ist(MONDAY, "13:00"))).toBe(
      `overnight:${MONDAY}`,
    );
    expect(slotFor("overnight", ist(SATURDAY, "08:00"))).toBeNull();
    expect(slotFor("morningRead", ist(MONDAY, "08:39"))).toBeNull();
    expect(slotFor("morningRead", ist(MONDAY, "08:40"))).toBe(
      `morningRead:${MONDAY}`,
    );
    expect(slotFor("morningRead", ist(MONDAY, "15:29"))).toBe(
      `morningRead:${MONDAY}`,
    );
    expect(slotFor("morningRead", ist(MONDAY, "15:30"))).toBeNull();
    expect(slotFor("morningRead", ist(SATURDAY, "08:40"))).toBeNull();
  });
});

describe("NewsScheduler — one attempt per job per slot", () => {
  const harness = (fail: JobName[] = []) => {
    const runs: [JobName, number][] = [];
    const errors: Record<string, unknown>[] = [];
    let clock = 0;
    const jobs = Object.fromEntries(
      JOBS.map((job) => [
        job,
        () => {
          runs.push([job, clock]);
          return fail.includes(job)
            ? Promise.reject(new Error(`${job} failed`))
            : Promise.resolve();
        },
      ]),
    ) as Record<JobName, () => Promise<void>>;
    const scheduler = new NewsScheduler({
      jobs,
      now: () => clock,
      onError: (_e, context) => errors.push(context),
    });
    const at = (t: number) => {
      clock = t;
      return scheduler.tick(t);
    };
    return { scheduler, runs, errors, at };
  };

  it("runs each due job once in its slot, again in the next slot", async () => {
    const { runs, at } = harness();
    await at(ist(MONDAY, "08:40"));
    await at(ist(MONDAY, "08:41"));
    await at(ist(MONDAY, "08:49"));
    await at(ist(MONDAY, "08:50"));
    expect(runs.map(([job]) => job)).toEqual([
      "general",
      "heavyweights",
      "overnight",
      "morningRead",
      "general", // 08:50, a new 10-minute slot; nothing else is due again
    ]);
  });

  it("spends a slot when it is tried: a failure is reported, not retried until the next slot", async () => {
    const { runs, errors, at } = harness(["general"]);
    await at(ist(MONDAY, "07:00"));
    await at(ist(MONDAY, "07:01"));
    expect(runs.filter(([job]) => job === "general")).toHaveLength(1);
    expect(errors).toEqual([
      {
        where: "newsScheduler",
        job: "general",
        slot: `general:${MONDAY}:m420`,
      },
    ]);
    await at(ist(MONDAY, "07:10"));
    expect(runs.filter(([job]) => job === "general")).toHaveLength(2);
  });

  it("never starts a job that is still running, even in a new slot", async () => {
    let release: () => void = () => undefined;
    const started: string[] = [];
    const scheduler = new NewsScheduler({
      now: () => 0,
      onError: () => undefined,
      jobs: {
        general: () => {
          started.push("general");
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        },
        heavyweights: () => Promise.resolve(),
        overnight: () => Promise.resolve(),
        morningRead: () => Promise.resolve(),
      },
    });
    const first = scheduler.tick(ist(SATURDAY, "10:00"));
    await scheduler.tick(ist(SATURDAY, "11:00")); // a new slot, still running
    expect(started).toEqual(["general"]);
    release();
    await first;
    const third = scheduler.tick(ist(SATURDAY, "12:00"));
    expect(started).toEqual(["general", "general"]);
    release();
    await third;
  });

  it("starts nothing once stopped", async () => {
    const { scheduler, runs, at } = harness();
    scheduler.stop();
    await at(ist(MONDAY, "09:00"));
    expect(runs).toEqual([]);
    expect(scheduler.isStopped).toBe(true);
  });
});
