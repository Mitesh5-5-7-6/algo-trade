import type { OptionChainSnapshot } from "@neelkanth/core";

/**
 * Keeps the option chain every few minutes of the session (PLAN.md 14.23,
 * operator decision 2026-11-28). Expired contracts cannot be fetched from the
 * broker afterwards; this is the only way research will ever have real option
 * prices, OI and IV to test strategies on.
 *
 * One snapshot per underlying per slot, slots aligned to the clock (09:15,
 * 09:20, …) so every day's rows line up. Called from the session tick and
 * never awaited by anything that trades: a slow or failed fetch costs a row,
 * never a decision. A slot is spent when tried, so a broker error is not
 * retried in a burst; the next slot tries again.
 */
export class OptionChainArchiver {
  private readonly lastSlot = new Map<string, number>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly deps: {
      underlyings: readonly string[];
      everyMs: number;
      read: (underlying: string) => Promise<OptionChainSnapshot | null>;
      keep: (snapshot: OptionChainSnapshot) => Promise<boolean>;
      onError: (error: unknown, context: Record<string, unknown>) => void;
    },
  ) {}

  async tick(now: number): Promise<void> {
    const slot = Math.floor(now / this.deps.everyMs);
    await Promise.all(
      this.deps.underlyings.map(async (underlying) => {
        if (this.lastSlot.get(underlying) === slot) return;
        if (this.inFlight.has(underlying)) return;
        this.lastSlot.set(underlying, slot);
        this.inFlight.add(underlying);
        try {
          const snapshot = await this.deps.read(underlying);
          if (snapshot !== null) await this.deps.keep(snapshot);
        } catch (error) {
          this.deps.onError(error, { where: "optionChainArchive", underlying });
        } finally {
          this.inFlight.delete(underlying);
        }
      }),
    );
  }
}
