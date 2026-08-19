import { describe, expect, it } from "vitest";
import type { Db } from "mongodb";
import type { Position, SessionContext } from "@neelkanth/core";
import type { EquityPoint } from "@neelkanth/engines";
import { createLogger } from "@neelkanth/logger";
import { buildServer } from "../server.js";
import { registerControlPlane } from "../control-plane/index.js";
import type { RuntimeControls } from "../control-plane/controls.js";

/**
 * The dashboard's REST calls, verbatim from `apps/dashboard/src/lib/api-client.ts`.
 * Every one of these 404'd against the static deployment. This test is the
 * standing guard that the surface actually covers them — a route silently
 * renamed or dropped shows up here rather than as a red row in DevTools.
 */
const DASHBOARD_CALLS: ReadonlyArray<readonly [string, string]> = [
  ["GET", "/positions"],
  ["GET", "/orders"],
  ["GET", "/activity"],
  ["GET", "/strategies"],
  ["GET", "/strategies/stats"],
  ["GET", "/strategies/types"],
  ["POST", "/strategies"],
  ["PATCH", "/strategies/:id"],
  ["DELETE", "/strategies/:id"],
  ["POST", "/strategies/:id/enable"],
  ["POST", "/strategies/:id/disable"],
  ["GET", "/settings"],
  ["PATCH", "/settings"],
  ["GET", "/pnl"],
  ["GET", "/pnl/curve"],
  ["GET", "/control/status"],
  ["POST", "/control/pause"],
  ["POST", "/control/kill"],
  ["POST", "/control/resume"],
];

/**
 * Registration only touches `db.collection(...)`; no handler runs in this test,
 * so a stub collection is enough to build the route table.
 */
function fakeDb(): Db {
  return { collection: () => ({}) } as unknown as Db;
}

function fakeRuntime(): RuntimeControls {
  return {
    setTradingEnabled: () => undefined,
    enableStrategy: () => Promise.resolve(),
    disableStrategy: () => undefined,
    applyGlobalSettings: () => undefined,
    getOpenPositions: (): Position[] => [],
    realizedPnl: () => 0,
    unrealizedPnl: () => 0,
    session: (): SessionContext => ({ phase: "closed", minutesSinceOpen: -1 }),
    equityCurve: (): readonly EquityPoint[] => [],
  };
}

function registeredRoutes(): Set<string> {
  const app = buildServer({
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

  const routes = new Set<string>();
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) routes.add(`${method} ${route.url}`);
  });

  registerControlPlane(app, {
    db: fakeDb(),
    runtime: fakeRuntime(),
    verifyStepUp: () => Promise.resolve(),
  });

  return routes;
}

describe("control-plane route coverage", () => {
  const routes = registeredRoutes();

  it.each(DASHBOARD_CALLS)("serves %s %s", (method, path) => {
    expect(routes).toContain(`${method} ${path}`);
  });

  it("covers every dashboard call, with none missing", () => {
    const missing = DASHBOARD_CALLS.filter(
      ([method, path]) => !routes.has(`${method} ${path}`),
    );
    expect(missing).toEqual([]);
  });
});
