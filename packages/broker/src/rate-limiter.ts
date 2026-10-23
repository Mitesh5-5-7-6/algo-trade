/**
 * A rate limiter a background job owns outright.
 *
 * **This overrides design §7.2**, which accepted a *shared* budget between the
 * backfill and live trading, using `FyersBrokerDeps.checkRateLimit` as the
 * seam, and only moved the job to its own process "if that guarantee cannot be
 * made". The guarantee cannot be made from inside one process by politeness
 * alone: a shared limiter means the backfill's 4,000th call and a real exit
 * order contend for the same token, and the one that loses is decided by
 * arrival order. A backfill losing costs a retry. An exit order losing costs
 * money, during the minute it mattered.
 *
 * So the separation is unconditional. A `RateLimiter` constructed for the
 * backfill is a distinct instance with its own budget; it can exhaust itself
 * completely without the order path ever waiting on it.
 *
 * What this does NOT do is make the vendor's own account-wide limit disappear.
 * Two local limiters still meet at one FYERS account, so the backfill's budget
 * must be set *below* what the account allows, leaving headroom for trading —
 * that headroom is a number from §3.1 Q3, which is why `minIntervalMs` has no
 * default. Isolation in this process is necessary and not sufficient; §7.2's
 * fallback of a separate process stays on the table for a full symbol list.
 */

export interface RateLimiterOptions {
  /**
   * Minimum gap between the START of consecutive calls, in ms.
   *
   * Required. It is derived from §3.1 Q3 minus the headroom live trading
   * needs, and a default here would be a guess about someone else's budget.
   */
  minIntervalMs: number;
  /**
   * How many calls may be in flight at once. Default 1.
   *
   * One is the honest default for a backfill: it is not latency-sensitive,
   * and concurrency buys nothing except a burst shape that looks to the vendor
   * exactly like the abuse their limiter exists to stop.
   */
  maxConcurrent?: number;
  /**
   * A hard ceiling on calls for the lifetime of this limiter, after which it
   * refuses rather than waits.
   *
   * A daily-quota backstop: a job that would otherwise spend the account's
   * entire allowance overnight stops and says so, instead of arriving at the
   * open with nothing left for trading.
   */
  maxCalls?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Thrown when the lifetime call ceiling is reached. Not retryable. */
export class RateLimitExhaustedError extends Error {
  readonly calls: number;
  constructor(calls: number) {
    super(
      `rate limiter exhausted after ${String(calls)} calls — raise maxCalls ` +
        "deliberately, or split the range across runs",
    );
    this.name = "RateLimitExhaustedError";
    this.calls = calls;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private readonly minIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly maxCalls: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private calls = 0;
  private inFlight = 0;
  /** When the next call is permitted to start. */
  private nextSlot = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(options: RateLimiterOptions) {
    if (!Number.isFinite(options.minIntervalMs) || options.minIntervalMs < 0)
      throw new Error("minIntervalMs must be a non-negative number");
    const concurrent = options.maxConcurrent ?? 1;
    if (!Number.isInteger(concurrent) || concurrent < 1)
      throw new Error("maxConcurrent must be a positive integer");

    this.minIntervalMs = options.minIntervalMs;
    this.maxConcurrent = concurrent;
    this.maxCalls = options.maxCalls ?? Number.POSITIVE_INFINITY;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Calls made through this limiter so far. */
  get callsMade(): number {
    return this.calls;
  }

  /**
   * Run `fn` when both the interval and the concurrency budget allow it.
   *
   * The slot is reserved *before* awaiting, so two callers that arrive in the
   * same tick are spaced rather than both seeing an idle limiter and firing
   * together — the bug that makes a limiter look correct under test and
   * useless under load.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.calls >= this.maxCalls)
      throw new RateLimitExhaustedError(this.calls);

    while (this.inFlight >= this.maxConcurrent) await this.waitForSlot();

    this.inFlight += 1;
    this.calls += 1;
    const startAt = Math.max(this.now(), this.nextSlot);
    this.nextSlot = startAt + this.minIntervalMs;

    try {
      const delay = startAt - this.now();
      if (delay > 0) await this.sleep(delay);
      return await fn();
    } finally {
      this.inFlight -= 1;
      this.waiters.shift()?.();
    }
  }

  private waitForSlot(): Promise<void> {
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}
