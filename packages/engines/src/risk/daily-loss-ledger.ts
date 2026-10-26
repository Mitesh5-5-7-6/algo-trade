/**
 * Durability for the daily-loss gate (§0.5.4).
 *
 * The gate reads the day's realized loss and blocks new entries once it
 * reaches the limit. That counter lived only in `PositionEngine`, zeroed at
 * MARKET_OPEN — so a mid-session restart forgot every loss the day had taken
 * and the machine started the afternoon believing it was flat. The limit that
 * exists to stop a bad day compounding was the one thing a crash cleared.
 *
 * This does not become a second counter. `PositionEngine` stays the authority
 * for realized P&L; the ledger persists that number and restores it at boot,
 * and knows whether it has been restored yet.
 */

export interface DailyLossPorts {
  /**
   * The persisted realized P&L for an IST trading date, or null if the day has
   * no record yet.
   *
   * Null must mean "never written", not "could not read" — those are opposite
   * facts and the second one must reach `hydrate` as a rejection.
   */
  read(dateIST: string): Promise<number | null>;
  write(dateIST: string, realizedPnl: number): Promise<void>;
}

export interface DailyLossLedgerDeps {
  ports: DailyLossPorts;
  /** Required error sink — no silent failures (plan/02 §10). */
  onError: (error: unknown, context: Record<string, unknown>) => void;
}

export class DailyLossLedger {
  private readonly deps: DailyLossLedgerDeps;
  /** The IST date this ledger is currently good for, or null before hydration. */
  private date: string | null = null;

  constructor(deps: DailyLossLedgerDeps) {
    this.deps = deps;
  }

  /**
   * Restore the day's realized P&L from storage.
   *
   * Returns the restored figure, or null when the day has no record — a fresh
   * day, which starts at zero. Rejects when storage cannot be read, and the
   * caller must let that propagate: see `lossFrom`.
   */
  async hydrate(dateIST: string): Promise<number | null> {
    const stored = await this.deps.ports.read(dateIST);
    this.date = dateIST;
    return stored;
  }

  /** Begin a new trading day at zero, and record that. */
  async startDay(dateIST: string): Promise<void> {
    this.date = dateIST;
    await this.persist(dateIST, 0);
  }

  /**
   * Persist the current realized P&L. Never rejects.
   *
   * A failed write is reported and swallowed, because the in-memory counter is
   * still correct for this process — the cost is paid only if it then crashes,
   * and taking down the trading path over a storage hiccup would be the larger
   * harm. The `hydrate` side is where a failure must be fatal, because there
   * the number is genuinely unknown.
   */
  async persist(dateIST: string, realizedPnl: number): Promise<void> {
    try {
      await this.deps.ports.write(dateIST, realizedPnl);
    } catch (error) {
      this.deps.onError(error, {
        where: "DailyLossLedger.persist",
        dateIST,
        note: "the in-memory counter is still correct; a restart would lose it",
      });
    }
  }

  /**
   * The loss the gate should compare against its limit.
   *
   * **Throws when the day is unknown**, which the Risk Engine turns into a
   * fail-closed block (plan/14 §9). That is the point: a gate that cannot
   * prove the limit is intact must not wave trades through, and returning zero
   * would be indistinguishable from a genuinely flat day.
   *
   * The date is checked, not assumed. A process running across midnight would
   * otherwise keep comparing yesterday's losses to today's limit.
   */
  lossFrom(realizedPnl: number, dateIST: string): number {
    if (this.date === null) {
      throw new Error(
        "daily-loss ledger not hydrated — the day's realized loss is unknown",
      );
    }
    if (this.date !== dateIST) {
      throw new Error(
        `daily-loss ledger holds ${this.date} but it is now ${dateIST}`,
      );
    }
    // Loss is a positive number; a profitable day has a loss of zero.
    return Math.max(0, -realizedPnl);
  }

  /** The date the ledger is good for, for diagnostics. */
  hydratedFor(): string | null {
    return this.date;
  }
}
