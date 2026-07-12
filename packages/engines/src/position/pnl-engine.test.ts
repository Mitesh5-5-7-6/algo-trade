import { describe, expect, it } from "vitest";
import type { PnlSnapshot, Position } from "@neelkanth/core";
import type { EventName } from "@neelkanth/contracts";
import { PnlEngine, type RealizedSnapshot } from "./pnl-engine.js";
import type { PnlPorts } from "./ports.js";

function position(overrides: Partial<Position>): Position {
  return {
    positionId: "p",
    symbol: "NSE:X-EQ",
    strategyId: "str_1",
    side: "LONG",
    qty: 10,
    avgEntryPrice: 100,
    status: "OPEN",
    realizedPnl: 0,
    unrealizedPnl: 0,
    openedAt: 0,
    mode: "paper",
    ...overrides,
  };
}

function harness(opts: {
  positions?: Position[];
  realized?: RealizedSnapshot;
  prices?: Record<string, number | null>;
}) {
  const events: { name: EventName; payload: unknown }[] = [];
  const snapshots: PnlSnapshot[] = [];
  const errors: unknown[] = [];
  const prices = opts.prices ?? { "NSE:X-EQ": 110 };
  const ports: PnlPorts = {
    readPrice: (s) => Promise.resolve(prices[s] ?? null),
    writeSnapshot: (snap) => {
      snapshots.push(snap);
      return Promise.resolve();
    },
    publish: (name, payload) => {
      events.push({ name, payload });
      return Promise.resolve();
    },
  };
  const engine = new PnlEngine({
    ports,
    getOpenPositions: () => opts.positions ?? [],
    getRealized: () => opts.realized ?? { global: 0, byStrategy: new Map() },
    getTradeCount: () => 3,
    now: () => 9000,
    onError: (error) => errors.push(error),
  });
  return { engine, events, snapshots, errors };
}

describe("PnlEngine.refresh (plan/13 §5)", () => {
  it("emits PNL_UPDATED with realized and mark-to-market unrealized", async () => {
    const h = harness({
      positions: [position({ qty: 10, avgEntryPrice: 100 })],
      realized: { global: 250, byStrategy: new Map([["str_1", 250]]) },
    });
    await h.engine.refresh();
    const payload = h.events[0]?.payload as {
      scope: string;
      realizedPnl: number;
      unrealizedPnl: number;
    };
    expect(h.events[0]?.name).toBe("PNL_UPDATED");
    expect(payload.scope).toBe("global");
    expect(payload.realizedPnl).toBe(250);
    expect(payload.unrealizedPnl).toBe(100); // (110−100)·10
  });

  it("holds the mark (contributes nothing) when price is missing (plan/13 §8)", async () => {
    const h = harness({
      positions: [position({})],
      prices: { "NSE:X-EQ": null },
    });
    await h.engine.refresh();
    const payload = h.events[0]?.payload as { unrealizedPnl: number };
    expect(payload.unrealizedPnl).toBe(0); // no fabricated mark
  });
});

describe("PnlEngine.snapshot (plan/13 §6)", () => {
  it("writes a global snapshot plus one per strategy", async () => {
    const h = harness({
      positions: [position({ qty: 10, avgEntryPrice: 100 })],
      realized: {
        global: 250,
        byStrategy: new Map([
          ["str_1", 150],
          ["str_2", 100],
        ]),
      },
    });
    await h.engine.snapshot("2026-01-05");
    const scopes = h.snapshots.map((s) => s.scope);
    expect(scopes).toEqual(["global", "strategy:str_1", "strategy:str_2"]);
    const global = h.snapshots[0];
    expect(global?.date).toBe("2026-01-05");
    expect(global?.realizedPnl).toBe(250);
    expect(global?.unrealizedPnl).toBe(100);
    expect(global?.equity).toBe(350); // realized + unrealized
    expect(global?.tradeCount).toBe(3);
  });
});
