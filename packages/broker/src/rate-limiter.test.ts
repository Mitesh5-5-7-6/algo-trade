import { describe, expect, it } from "vitest";
import { RateLimiter, RateLimitExhaustedError } from "./rate-limiter.js";

/**
 * The override of design §7.2: the backfill owns its limiter outright.
 *
 * The property that matters is isolation — one limiter's exhaustion must not
 * make another wait — because that is the whole reason for not sharing one
 * with the live order path.
 */

/** A clock that only moves when the limiter sleeps, so tests are exact. */
function fakeClock() {
  let time = 1_000;
  return {
    now: () => time,
    sleep: (ms: number) => {
      time += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      time += ms;
    },
    at: () => time,
  };
}

describe("RateLimiter — spacing", () => {
  it("runs the first call without waiting", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ minIntervalMs: 500, ...clock });
    const startedAt: number[] = [];

    await limiter.run(() => {
      startedAt.push(clock.at());
      return Promise.resolve();
    });
    expect(startedAt).toEqual([1_000]);
  });

  it("spaces consecutive calls by the interval", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ minIntervalMs: 500, ...clock });
    const startedAt: number[] = [];
    const record = () => {
      startedAt.push(clock.at());
      return Promise.resolve();
    };

    await limiter.run(record);
    await limiter.run(record);
    await limiter.run(record);

    expect(startedAt).toEqual([1_000, 1_500, 2_000]);
  });

  /**
   * The bug that makes a limiter look correct under test and useless under
   * load: two callers arriving in the same tick both see an idle limiter and
   * fire together. The slot must be reserved before awaiting.
   */
  it("spaces callers that arrive in the same tick", async () => {
    // Asserted on the delays the limiter ASKS for, not on an observed clock:
    // three racing callers interleave, and a shared mutable clock would report
    // whatever the last sleep left behind rather than each slot.
    const waits: number[] = [];
    const limiter = new RateLimiter({
      minIntervalMs: 200,
      maxConcurrent: 4,
      now: () => 1_000,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    const noop = () => Promise.resolve();

    await Promise.all([
      limiter.run(noop),
      limiter.run(noop),
      limiter.run(noop),
    ]);

    // First goes immediately; the next two are pushed out one interval each.
    expect(waits).toEqual([200, 400]);
  });

  it("does not make a caller wait when the interval has already passed", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ minIntervalMs: 100, ...clock });
    await limiter.run(() => Promise.resolve());
    clock.advance(5_000);

    const startedAt: number[] = [];
    await limiter.run(() => {
      startedAt.push(clock.at());
      return Promise.resolve();
    });
    expect(startedAt[0]).toBe(6_000);
  });

  it("accepts a zero interval", async () => {
    const limiter = new RateLimiter({ minIntervalMs: 0 });
    let calls = 0;
    await limiter.run(() => {
      calls += 1;
      return Promise.resolve();
    });
    expect(calls).toBe(1);
  });
});

describe("RateLimiter — concurrency", () => {
  /**
   * One is the honest default for a backfill. It is not latency-sensitive,
   * and concurrency buys nothing except a burst shape that looks to the
   * vendor exactly like the abuse their limiter exists to stop.
   */
  it("runs one call at a time by default", async () => {
    const limiter = new RateLimiter({
      minIntervalMs: 0,
      sleep: () => Promise.resolve(),
    });
    let inFlight = 0;
    let peak = 0;
    const task = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    };

    await Promise.all([
      limiter.run(task),
      limiter.run(task),
      limiter.run(task),
    ]);
    expect(peak).toBe(1);
  });

  it("honours a raised concurrency limit", async () => {
    const limiter = new RateLimiter({
      minIntervalMs: 0,
      maxConcurrent: 2,
      sleep: () => Promise.resolve(),
    });
    let inFlight = 0;
    let peak = 0;
    // Definite assignment: the executor runs synchronously, but TS narrows a
    // nullable to null because it cannot see that.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const task = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight -= 1;
    };

    const runs = [limiter.run(task), limiter.run(task), limiter.run(task)];
    await Promise.resolve();
    await Promise.resolve();
    release();
    await Promise.all(runs);

    expect(peak).toBe(2);
  });

  it("frees its slot when a call throws", async () => {
    const limiter = new RateLimiter({
      minIntervalMs: 0,
      sleep: () => Promise.resolve(),
    });
    await expect(
      limiter.run(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    // If the slot leaked, this would never resolve.
    await expect(limiter.run(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});

describe("RateLimiter — the budget ceiling", () => {
  /**
   * A job that would spend the account's whole allowance overnight stops and
   * says so, instead of arriving at the open with nothing left for trading.
   */
  it("refuses once the call ceiling is reached", async () => {
    const limiter = new RateLimiter({
      minIntervalMs: 0,
      maxCalls: 2,
      sleep: () => Promise.resolve(),
    });
    await limiter.run(() => Promise.resolve());
    await limiter.run(() => Promise.resolve());

    await expect(limiter.run(() => Promise.resolve())).rejects.toBeInstanceOf(
      RateLimitExhaustedError,
    );
    expect(limiter.callsMade).toBe(2);
  });

  it("counts a failed call against the budget", async () => {
    const limiter = new RateLimiter({
      minIntervalMs: 0,
      sleep: () => Promise.resolve(),
    });
    await expect(
      limiter.run(() => Promise.reject(new Error("x"))),
    ).rejects.toThrow();
    // The vendor was called; whether we liked the answer is irrelevant.
    expect(limiter.callsMade).toBe(1);
  });

  it("is unbounded when no ceiling is set", async () => {
    const limiter = new RateLimiter({
      minIntervalMs: 0,
      sleep: () => Promise.resolve(),
    });
    for (let i = 0; i < 50; i += 1) await limiter.run(() => Promise.resolve());
    expect(limiter.callsMade).toBe(50);
  });
});

describe("RateLimiter — isolation is the point", () => {
  /**
   * The §7.2 override in one assertion. Under a shared limiter the backfill's
   * last call and a live exit order contend for one token and arrival order
   * decides which loses — the backfill losing costs a retry, the exit losing
   * costs money. Two instances cannot contend.
   */
  it("one limiter's exhaustion leaves another completely free", async () => {
    const backfill = new RateLimiter({
      minIntervalMs: 0,
      maxCalls: 1,
      sleep: () => Promise.resolve(),
    });
    const live = new RateLimiter({
      minIntervalMs: 0,
      sleep: () => Promise.resolve(),
    });

    await backfill.run(() => Promise.resolve());
    await expect(backfill.run(() => Promise.resolve())).rejects.toBeInstanceOf(
      RateLimitExhaustedError,
    );

    await expect(live.run(() => Promise.resolve("filled"))).resolves.toBe(
      "filled",
    );
    expect(live.callsMade).toBe(1);
  });

  it("a slow backfill call does not delay another limiter", async () => {
    const clock = fakeClock();
    const backfill = new RateLimiter({ minIntervalMs: 60_000, ...clock });
    const live = new RateLimiter({ minIntervalMs: 0, ...clock });

    await backfill.run(() => Promise.resolve());
    const before = clock.at();
    await live.run(() => Promise.resolve());
    expect(clock.at()).toBe(before);
  });
});

describe("RateLimiter — construction", () => {
  it.each([-1, Number.NaN])("rejects minIntervalMs %s", (value) => {
    expect(() => new RateLimiter({ minIntervalMs: value })).toThrow(
      /minIntervalMs/,
    );
  });

  it.each([0, -1, 1.5])("rejects maxConcurrent %s", (value) => {
    expect(
      () => new RateLimiter({ minIntervalMs: 0, maxConcurrent: value }),
    ).toThrow(/maxConcurrent/);
  });
});
