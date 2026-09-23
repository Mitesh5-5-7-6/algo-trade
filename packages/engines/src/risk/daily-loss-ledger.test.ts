import { describe, expect, it } from "vitest";
import { DailyLossLedger, type DailyLossPorts } from "./daily-loss-ledger.js";
import { PositionEngine } from "../position/position-engine.js";

/**
 * §0.5.4 — the daily-loss gate must survive a restart.
 *
 * The bug being closed: the counter lived only in memory and was zeroed at
 * MARKET_OPEN, so a mid-session crash cleared the day's losses and the machine
 * started the afternoon believing it was flat. The limit that exists to stop a
 * bad day compounding was the one thing a restart reset.
 */

const TODAY = "2026-09-17";
const TOMORROW = "2026-09-18";

/** A store that behaves like Redis: a value, or nothing. */
function fakeStore(seed: Record<string, number> = {}) {
  const values = new Map<string, number>(Object.entries(seed));
  const errors = { read: false, write: false };
  const ports: DailyLossPorts = {
    read: (dateIST) => {
      if (errors.read) return Promise.reject(new Error("redis is down"));
      return Promise.resolve(values.get(dateIST) ?? null);
    },
    write: (dateIST, realizedPnl) => {
      if (errors.write) return Promise.reject(new Error("redis is down"));
      values.set(dateIST, realizedPnl);
      return Promise.resolve();
    },
  };
  return { ports, values, errors };
}

const ledgerOn = (
  store: ReturnType<typeof fakeStore>,
  reported: Record<string, unknown>[] = [],
): DailyLossLedger =>
  new DailyLossLedger({
    ports: store.ports,
    onError: (_error, context) => reported.push(context),
  });

describe("DailyLossLedger", () => {
  it("reports a day it has never seen as absent, not as zero", async () => {
    const ledger = ledgerOn(fakeStore());
    expect(await ledger.hydrate(TODAY)).toBeNull();
  });

  it("restores a day that was written", async () => {
    const ledger = ledgerOn(fakeStore({ [TODAY]: -4_200 }));
    expect(await ledger.hydrate(TODAY)).toBe(-4_200);
    expect(ledger.lossFrom(-4_200, TODAY)).toBe(4_200);
  });

  /**
   * The whole point of the ledger. Zero and "unknown" are opposite facts, and
   * a gate that cannot tell them apart waves through exactly the trades it
   * exists to stop.
   */
  it("refuses to report a loss before it has been hydrated", () => {
    const ledger = ledgerOn(fakeStore());
    expect(() => ledger.lossFrom(-9_000, TODAY)).toThrow(/not hydrated/);
  });

  /** A process running past midnight must not judge today against yesterday. */
  it("refuses to report a loss for a different day than it holds", async () => {
    const ledger = ledgerOn(fakeStore({ [TODAY]: -4_200 }));
    await ledger.hydrate(TODAY);
    expect(() => ledger.lossFrom(-4_200, TOMORROW)).toThrow(
      /holds 2026-09-17 but it is now 2026-09-18/,
    );
  });

  it("calls a profitable day a loss of zero", async () => {
    const ledger = ledgerOn(fakeStore());
    await ledger.hydrate(TODAY);
    expect(ledger.lossFrom(7_500, TODAY)).toBe(0);
  });

  it("starts a new day at zero, durably", async () => {
    const store = fakeStore({ [TODAY]: -4_200 });
    const ledger = ledgerOn(store);
    await ledger.startDay(TOMORROW);
    expect(store.values.get(TOMORROW)).toBe(0);
    expect(ledger.lossFrom(0, TOMORROW)).toBe(0);
    // Yesterday's record is left alone; its own TTL removes it.
    expect(store.values.get(TODAY)).toBe(-4_200);
  });

  /**
   * Asymmetric on purpose. A failed WRITE is survivable — the in-memory
   * counter is still correct for this process — so taking down the trading
   * path over it would be the larger harm. A failed READ is not, because there
   * the number is genuinely unknown.
   */
  it("reports a failed write and keeps going", async () => {
    const store = fakeStore();
    const reported: Record<string, unknown>[] = [];
    const ledger = ledgerOn(store, reported);
    store.errors.write = true;

    await expect(ledger.persist(TODAY, -100)).resolves.toBeUndefined();
    expect(reported[0]).toMatchObject({ where: "DailyLossLedger.persist" });
  });

  it("rejects a failed read rather than pretending the day is fresh", async () => {
    const store = fakeStore();
    const ledger = ledgerOn(store);
    store.errors.read = true;

    await expect(ledger.hydrate(TODAY)).rejects.toThrow("redis is down");
    // And it is still not hydrated, so the gate stays closed.
    expect(() => ledger.lossFrom(0, TODAY)).toThrow(/not hydrated/);
  });
});

describe("the restart the ledger exists to survive", () => {
  const noop = (): void => undefined;

  const engineOn = (): PositionEngine =>
    new PositionEngine({
      ports: {
        writePosition: () => Promise.resolve(),
        publish: () => Promise.resolve(),
      },
      nextPositionId: () => "pos_1",
      now: () => 1,
      onError: noop,
    });

  /**
   * The failing scenario, end to end: lose ₹30,000 in the morning, crash,
   * come back. Before this the gate saw a flat day and would have allowed the
   * afternoon to lose another ₹30,000 against a ₹40,000 limit.
   */
  it("carries the morning's loss across a restart", async () => {
    const store = fakeStore();

    // --- process 1: the morning ---
    const morning = ledgerOn(store);
    await morning.startDay(TODAY);
    await morning.persist(TODAY, -30_000);
    expect(morning.lossFrom(-30_000, TODAY)).toBe(30_000);

    // --- process 2: after the crash ---
    const afternoon = ledgerOn(store);
    const restored = await afternoon.hydrate(TODAY);
    expect(restored).toBe(-30_000);

    const engine = engineOn();
    expect(engine.realizedPnl()).toBe(0); // a fresh engine knows nothing
    engine.seedDailyRealized(restored ?? 0);
    expect(afternoon.lossFrom(engine.realizedPnl(), TODAY)).toBe(30_000);
  });

  /**
   * Seeding restores the GLOBAL counter only. Per-strategy realized P&L is a
   * separately recorded gap, and inventing a split would hide it rather than
   * close it.
   */
  it("restores the global counter without fabricating a per-strategy split", () => {
    const engine = engineOn();
    engine.seedDailyRealized(-30_000);
    expect(engine.realizedPnl()).toBe(-30_000);
    expect(engine.realizedPnlForStrategy("str_any")).toBe(0);
    expect(engine.getTradeCount()).toBe(0);
  });

  it("is cleared by the next session's open, not carried into it", async () => {
    const store = fakeStore({ [TODAY]: -30_000 });
    const ledger = ledgerOn(store);
    await ledger.hydrate(TODAY);

    const engine = engineOn();
    engine.seedDailyRealized(-30_000);

    // MARKET_OPEN on the next trading day.
    engine.resetDaily();
    await ledger.startDay(TOMORROW);

    expect(ledger.lossFrom(engine.realizedPnl(), TOMORROW)).toBe(0);
    expect(store.values.get(TOMORROW)).toBe(0);
  });
});
