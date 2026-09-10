import { describe, expect, it } from "vitest";
import type { Db } from "mongodb";
import type { Position, SessionContext } from "@neelkanth/core";
import type { EquityPoint } from "@neelkanth/engines";
import { createLogger } from "@neelkanth/logger";
import { buildServer, type ApiServer } from "../server.js";
import { registerControlPlane } from "./routes.js";
import type { RuntimeControls } from "./controls.js";

/**
 * A bare ticker was accepted, subscribed, and matched nothing: the feed read
 * healthy, the strategy sat enabled, and it produced no signal for a whole
 * session with nothing anywhere explaining why. The boundary is where that has
 * to be caught (plan/04 §4).
 */
function app(): ApiServer {
  const server = buildServer({
    logger: createLogger({
      level: "fatal",
      name: "test",
      destination: {
        write() {
          return true;
        },
      },
    }),
    readinessChecks: [],
  });
  const runtime: RuntimeControls = {
    setTradingEnabled: () => undefined,
    enableStrategy: () => Promise.resolve(),
    disableStrategy: () => undefined,
    applyGlobalSettings: () => undefined,
    getOpenPositions: (): Position[] => [],
    realizedPnl: () => 0,
    unrealizedPnl: () => 0,
    session: (): SessionContext => ({ phase: "closed", minutesSinceOpen: -1, sessionOpenTs: 0 }),
    equityCurve: (): readonly EquityPoint[] => [],
    brokerConnection: () => ({ state: "connected", connected: true }),
  };
  registerControlPlane(server, {
    db: { collection: () => ({}) } as unknown as Db,
    runtime,
    verifyStepUp: () => Promise.resolve(),
  });
  return server;
}

/** Validation runs before any repository call, so no DB is needed. */
async function patchSymbols(symbols: string[]) {
  const server = app();
  const res = await server.inject({
    method: "PATCH",
    url: "/strategies/str_1",
    payload: { symbols },
  });
  await server.close();
  return res;
}

describe("strategy symbol validation", () => {
  it.each([
    "RELIANCE",
    "HDFCBANK",
    "ICICIBANK",
    "INFY",
    "TCS",
    "NSE",
  ])("rejects the bare ticker %s", async (symbol) => {
    const res = await patchSymbols([symbol]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it.each([
    "NSE:RELIANCE-EQ",
    "NSE:HDFCBANK-EQ",
    "NSE:SBIN-EQ",
    "BSE:RELIANCE-A",
    "MCX:CRUDEOIL24AUGFUT",
    "NSE:NIFTY50-INDEX",
  ])("accepts the normalized symbol %s", async (symbol) => {
    const res = await patchSymbols([symbol]);
    // Past validation: the failure below is the fake DB, not the symbol.
    expect(res.statusCode).not.toBe(400);
  });

  it("rejects a list where only one symbol is malformed", async () => {
    // Silently subscribing the good half would be worse: partial data looks
    // like a working strategy that simply never fires on one instrument.
    const res = await patchSymbols(["NSE:SBIN-EQ", "RELIANCE"]);
    expect(res.statusCode).toBe(400);
  });

  it("explains what the symbol should look like", async () => {
    const res = await patchSymbols(["RELIANCE"]);
    expect(res.body).toContain("NSE:RELIANCE-EQ");
  });

  it("rejects an empty symbol list", async () => {
    const res = await patchSymbols([]);
    expect(res.statusCode).toBe(400);
  });
});
