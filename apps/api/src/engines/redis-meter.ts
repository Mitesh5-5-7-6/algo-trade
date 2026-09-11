import type { Redis } from "ioredis";
import type { Logger } from "@neelkanth/logger";

/**
 * Counts Redis commands in memory so the cost of a change is measured rather
 * than argued about.
 *
 * Deliberately local: a counter that stored its own numbers in Redis would be
 * part of the problem it exists to measure. Nothing here issues a command.
 */
export class RedisMeter {
  private readonly counts = new Map<string, number>();
  private since = Date.now();

  record(command: string): void {
    this.counts.set(command, (this.counts.get(command) ?? 0) + 1);
  }

  total(): number {
    let sum = 0;
    for (const n of this.counts.values()) sum += n;
    return sum;
  }

  /** A snapshot of the window, then reset — so each report covers one period. */
  drain(): {
    seconds: number;
    total: number;
    perSecond: number;
    byCommand: Record<string, number>;
  } {
    const seconds = Math.max((Date.now() - this.since) / 1000, 0.001);
    const total = this.total();
    const byCommand = Object.fromEntries(
      [...this.counts.entries()].sort(([, a], [, b]) => b - a),
    );
    this.counts.clear();
    this.since = Date.now();
    return {
      seconds: Number(seconds.toFixed(1)),
      total,
      perSecond: Number((total / seconds).toFixed(2)),
      byCommand,
    };
  }
}

/**
 * Wrap an ioredis client so every command it issues is tallied.
 *
 * A Proxy rather than a subclass: ioredis exposes commands as dynamically
 * generated methods, so there is no fixed list to override, and the wrapper
 * must not change the object's behaviour in any other way.
 */
export function meterRedis(client: Redis, meter: RedisMeter): Redis {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function" || typeof property !== "string") {
        return value;
      }
      // Not commands — plumbing that would otherwise inflate the count.
      if (property === "on" || property === "once" || property === "off") {
        return (value as (...a: unknown[]) => unknown).bind(target);
      }
      return (...args: unknown[]): unknown => {
        meter.record(property);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/**
 * Log a command-rate report on an interval. Returns a stop function.
 *
 * Off unless `REDIS_METER_MS` is set, so production pays nothing for it.
 */
export function startRedisMeterReport(
  meter: RedisMeter,
  log: Logger,
  intervalMs: number,
): () => void {
  const timer = setInterval(() => {
    const report = meter.drain();
    if (report.total === 0) return;
    log.info(report, "redis command rate");
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
