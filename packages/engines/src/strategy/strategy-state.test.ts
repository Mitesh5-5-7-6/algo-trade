import { describe, expect, it } from "vitest";
import type { Candle, StrategyConfig } from "@neelkanth/core";
import { createStrategyRegistry } from "@neelkanth/strategies";
import { StrategyRunner } from "./strategy-runner.js";
import type { StoredStrategyState, StrategyPorts } from "./ports.js";

/**
 * §0.5.6 — one session, two process lifetimes, the same decisions.
 *
 * The bug: strategy state lived only in memory, so a restarted process came
 * back believing nothing had happened yet.
 *
 * Not every piece of that state needed persisting, and the distinction is the
 * interesting part. Anything DERIVABLE from the candle window is better
 * recomputed — ORB already reads its opening range out of the window for
 * exactly this reason. What cannot be derived is the record of what the system
 * DID: whether today's one-shot entry was taken, and what the previous bar's
 * indicators were when the cross was half-formed. Those are what is stored.
 */

const SYMBOL = "NSE:ORB-EQ";
const SESSION_OPEN = Date.UTC(2026, 0, 5, 3, 45); // 09:15 IST
const BAR_MS = 300_000;

const bar = (index: number, fields: Partial<Candle> = {}): Candle => ({
  symbol: SYMBOL,
  interval: "5m",
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1_000,
  ts: SESSION_OPEN + index * BAR_MS,
  ...fields,
});

/** Bars 0–2 define a 100–90 opening range. */
const MORNING = [
  bar(0, { high: 99, low: 91, close: 95 }),
  bar(1, { high: 100, low: 90, close: 96 }),
  bar(2, { high: 98, low: 92, close: 95 }),
];

const orbConfig: StrategyConfig = {
  strategyId: "str_orb",
  ownerId: "u",
  type: "ORB",
  name: "ORB",
  params: { rangeMinutes: 15 },
  symbols: [SYMBOL],
  enabled: true,
  status: "active",
  createdAt: 0,
  updatedAt: 0,
};

/** A store shared between two "processes", like the real collection. */
function store() {
  const rows = new Map<string, StoredStrategyState>();
  return {
    rows,
    load: (strategyId: string, symbol: string) =>
      Promise.resolve(rows.get(`${strategyId}|${symbol}`) ?? null),
    save: (state: StoredStrategyState) => {
      rows.set(`${state.strategyId}|${state.symbol}`, state);
      return Promise.resolve();
    },
  };
}

/**
 * One process lifetime.
 *
 * `persist` false is the old behaviour: the ports are simply absent, every
 * strategy starts cold, and nothing is written.
 */
function lifetime(shared: ReturnType<typeof store>, persist = true) {
  const candles: Candle[] = [];
  const forwarded: { side: string; reason: string }[] = [];
  const errors: Record<string, unknown>[] = [];

  const ports: StrategyPorts = {
    readSession: () =>
      Promise.resolve({
        phase: "open" as const,
        minutesSinceOpen:
          ((candles.at(-1)?.ts ?? SESSION_OPEN) - SESSION_OPEN) / 60_000 + 5,
        sessionOpenTs: SESSION_OPEN,
      }),
    readCandleWindow: () => Promise.resolve([...candles]),
    readPosition: () => Promise.resolve(null),
    readSentiment: () => Promise.resolve(0),
    resolveContract: () => null,
    readPrice: () => null,
    persistSignal: () => Promise.resolve(),
    publish: () => Promise.resolve(),
    ...(persist
      ? { loadStrategyState: shared.load, saveStrategyState: shared.save }
      : {}),
  };

  let idSeq = 0;
  const runner = new StrategyRunner({
    registry: createStrategyRegistry(),
    ports,
    provisionIndicators: () => Promise.resolve(),
    handoff: (signal) => {
      forwarded.push({ side: signal.side, reason: signal.reason });
      return Promise.resolve();
    },
    nextSignalId: () => {
      idSeq += 1;
      return `sig_${String(idSeq)}`;
    },
    now: () => 1_760_000_000_000,
    onError: (_error, context) => errors.push(context),
  });

  /** Put a bar in the window without running a decision on it. */
  const feedWindowOnly = (candle: Candle): void => {
    candles.push(candle);
  };

  const feed = async (candle: Candle): Promise<void> => {
    candles.push(candle);
    runner.onCandleClosed(candle);
    await runner.onIndicatorsUpdated({
      symbol: SYMBOL,
      interval: "5m",
      indicators: {},
      ts: candle.ts,
    });
  };

  return { runner, feed, feedWindowOnly, forwarded, errors };
}

describe("strategy state across a restart", () => {
  /**
   * ORB's opening range is NOT what persistence recovers, and it is worth
   * saying so: the strategy derives the range from the candle window rather
   * than accumulating it bar by bar, precisely so a process that started at
   * 11:20 is not left holding null all day. The window itself is seeded from
   * stored candles at boot.
   *
   * What a restart genuinely loses is the LATCH — whether today's entry has
   * already been taken — and that is what the next two tests are about.
   */
  it("rebuilds the opening range from the candle window, not from a snapshot", async () => {
    const shared = store();
    // A process that has never seen the morning, only the bars.
    const late = lifetime(shared);
    await late.runner.enable(orbConfig);
    for (const candle of MORNING) late.feedWindowOnly(candle);
    await late.feed(bar(3, { close: 101 }));

    expect(late.forwarded).toEqual([
      { side: "BUY", reason: "close above the opening-range high" },
    ]);
    expect(shared.rows.size).toBe(1);
  });

  /**
   * The latch is the part of the state that most needs to survive: a restart
   * that forgot an entry was confirmed would take the day's entry twice.
   */
  it("does not re-enter after a restart when the entry was already filled", async () => {
    const shared = store();

    const morning = lifetime(shared);
    await morning.runner.enable(orbConfig);
    for (const candle of MORNING) await morning.feed(candle);
    await morning.feed(bar(3, { close: 101 }));
    expect(morning.forwarded).toHaveLength(1);

    morning.runner.onOrderPlaced({
      orderId: "ord_1",
      signalId: "sig_4",
      strategyId: "str_orb",
      symbol: SYMBOL,
      side: "BUY",
      qty: 10,
      type: "MARKET",
      mode: "paper",
      ts: 1,
    });
    morning.runner.onOrderFilled({
      orderId: "ord_1",
      strategyId: "str_orb",
      symbol: SYMBOL,
      side: "BUY",
      qty: 10,
      filledPrice: 101,
      slippage: 0,
      charges: 0,
      filledAt: 1,
      mode: "paper",
      ts: 1,
    });

    const afternoon = lifetime(shared);
    await afternoon.runner.enable(orbConfig);
    await afternoon.feed(bar(4, { close: 105 }));
    expect(afternoon.forwarded).toEqual([]);
  });

  /**
   * And the other half: a proposal that was BLOCKED must not come back as a
   * spent latch either. Together with §0.5.5 this is the property that makes
   * the two fixes worth having at once.
   */
  it("still enters after a restart when the entry was only blocked", async () => {
    const shared = store();

    const morning = lifetime(shared);
    await morning.runner.enable(orbConfig);
    for (const candle of MORNING) await morning.feed(candle);
    await morning.feed(bar(3, { close: 101 }));
    morning.runner.onRiskBlocked({
      signalId: "sig_4",
      strategyId: "str_orb",
      symbol: SYMBOL,
      failedCheck: "marketBias",
      reason: "against the index",
      ts: 1,
    });

    const afternoon = lifetime(shared);
    await afternoon.runner.enable(orbConfig);
    await afternoon.feed(bar(4, { close: 103 }));
    expect(afternoon.forwarded).toEqual([
      { side: "BUY", reason: "close above the opening-range high" },
    ]);
  });
});

describe("what the runner refuses to restore", () => {
  const foreign = (
    overrides: Partial<StoredStrategyState>,
  ): StoredStrategyState => ({
    strategyId: "str_orb",
    symbol: SYMBOL,
    type: "ORB",
    stateVersion: "1.0.0",
    snapshot: {
      sessionMarker: SESSION_OPEN,
      orHigh: 100,
      orLow: 90,
      upEntry: "none",
      downEntry: "none",
    },
    updatedAt: 1,
    ...overrides,
  });

  /**
   * A snapshot is an opaque blob whose meaning lives entirely in the code that
   * wrote it. Read one back into a later build whose fields mean something
   * else and the result is a running strategy with plausible state and no
   * error anywhere — which is why each refusal below is loud.
   */
  it("refuses a snapshot from a different state version", async () => {
    const shared = store();
    shared.rows.set(`str_orb|${SYMBOL}`, foreign({ stateVersion: "0.9.0" }));

    const process = lifetime(shared);
    await process.runner.enable(orbConfig);
    await process.feed(bar(3, { close: 101 }));

    expect(process.forwarded).toEqual([]); // cold, as it was before persistence
    expect(process.errors.some((c) => c["where"] === "hydrateState")).toBe(
      true,
    );
  });

  it("refuses a snapshot written by a different strategy", async () => {
    const shared = store();
    shared.rows.set(`str_orb|${SYMBOL}`, foreign({ type: "EMA_CROSSOVER" }));

    const process = lifetime(shared);
    await process.runner.enable(orbConfig);
    await process.feed(bar(3, { close: 101 }));

    expect(process.forwarded).toEqual([]);
    expect(process.errors.some((c) => c["expected"] === "ORB")).toBe(true);
  });

  it("starts cold rather than throwing on a snapshot it cannot parse", async () => {
    const shared = store();
    shared.rows.set(`str_orb|${SYMBOL}`, foreign({ snapshot: { junk: true } }));

    const process = lifetime(shared);
    await expect(process.runner.enable(orbConfig)).resolves.toBeUndefined();
    expect(process.errors.some((c) => c["where"] === "hydrateState")).toBe(
      true,
    );
  });

  /**
   * One write per bar per instance would be a real cost at scale, and most
   * bars move nothing a strategy would read back.
   */
  it("writes nothing when the state did not change", async () => {
    const shared = store();
    let writes = 0;
    const counting = {
      ...shared,
      save: (state: StoredStrategyState) => {
        writes += 1;
        return shared.save(state);
      },
    };

    const process = lifetime(counting);
    await process.runner.enable(orbConfig);
    for (const candle of MORNING) await process.feed(candle);
    // The first bar past the range resolves it — that is a change.
    await process.feed(bar(3, { close: 95 }));
    const settled = writes;
    // These move nothing: the range is fixed and neither breaks it.
    await process.feed(bar(4, { close: 96 }));
    await process.feed(bar(5, { close: 94 }));
    expect(writes).toBe(settled);
  });
});
