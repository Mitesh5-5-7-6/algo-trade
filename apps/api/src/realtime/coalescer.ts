/**
 * Coalesce-to-latest throttle (plan/10 §6). High-frequency streams — market
 * ticks, unrealized PnL — change many times a second; a browser can't usefully
 * render that and would pin its CPU trying. So the bridge keeps only the LATEST
 * value per key and flushes on a fixed interval: a smooth, current display at a
 * fraction of the cost. The flood is absorbed server-side and never leaves.
 *
 * The interval timer only runs while there is pending data — it stops itself
 * when idle and restarts on the next push, so a quiet market costs nothing.
 */
export class Coalescer<T> {
  private readonly latest = new Map<string, T>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly intervalMs: number,
    private readonly flush: (key: string, value: T) => void,
  ) {}

  push(key: string, value: T): void {
    this.latest.set(key, value);
    if (this.timer === null) {
      this.timer = setInterval(() => {
        this.drain();
      }, this.intervalMs);
      this.timer.unref(); // never keep the process alive on this timer alone
    }
  }

  private drain(): void {
    if (this.latest.size === 0) {
      // Idle — stop the timer; the next push restarts it.
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
      return;
    }
    for (const [key, value] of this.latest) {
      this.flush(key, value);
    }
    this.latest.clear();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.latest.clear();
  }
}
