import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "@neelkanth/logger";
import { buildServer, type ApiServer } from "./server.js";
import {
  NotFoundError,
  RiskViolationError,
  StepUpRequiredError,
  ValidationError,
} from "./errors.js";
import type { DependencyCheck } from "./health.js";

/** Silent logger — swallow output during tests. */
function silentLogger() {
  return createLogger({
    level: "fatal",
    name: "test",
    destination: {
      write() {
        return true;
      },
    },
  });
}

function makeServer(checks: readonly DependencyCheck[]): ApiServer {
  return buildServer({ logger: silentLogger(), readinessChecks: checks });
}

describe("health routes (plan/23 §4)", () => {
  let app: ApiServer;
  afterEach(async () => {
    await app.close();
  });

  it("liveness is 200 regardless of dependencies (asks 'restart me?')", async () => {
    app = makeServer([{ name: "redis", probe: () => Promise.resolve(false) }]);
    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "live" });
  });

  it("readiness is 200 when all dependencies are up", async () => {
    app = makeServer([
      { name: "mongo", probe: () => Promise.resolve(true) },
      { name: "redis", probe: () => Promise.resolve(true) },
    ]);
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ready",
      dependencies: { mongo: "up", redis: "up" },
    });
  });

  it("readiness is 503 when a dependency is down (asks 'trust me?')", async () => {
    app = makeServer([
      { name: "mongo", probe: () => Promise.resolve(true) },
      { name: "redis", probe: () => Promise.resolve(false) },
    ]);
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: "unready",
      dependencies: { redis: "down" },
    });
  });
});

describe("central error handler (plan/05 §5)", () => {
  let app: ApiServer;
  afterEach(async () => {
    await app.close();
  });

  beforeEach(() => {
    app = makeServer([]);
  });

  it("maps typed domain errors to their status + code envelope", async () => {
    app.get("/not-found", () => {
      throw new NotFoundError("strategy not found", { strategyId: "str_x" });
    });
    app.get("/risk", () => {
      throw new RiskViolationError("override may only be stricter");
    });
    app.get("/stepup", () => {
      throw new StepUpRequiredError("re-enable requires re-auth");
    });

    const notFound = await app.inject({ method: "GET", url: "/not-found" });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toEqual({
      error: { code: "NOT_FOUND", message: "strategy not found" },
    });

    const risk = await app.inject({ method: "GET", url: "/risk" });
    expect(risk.statusCode).toBe(422);
    expect(risk.json()).toMatchObject({ error: { code: "RISK_VIOLATION" } });

    const stepUp = await app.inject({ method: "GET", url: "/stepup" });
    expect(stepUp.statusCode).toBe(403);
    expect(stepUp.json()).toMatchObject({
      error: { code: "STEP_UP_REQUIRED" },
    });
  });

  it("maps an unexpected error to an opaque 500 (no internal leak)", async () => {
    app.get("/boom", () => {
      throw new Error("secret internal detail");
    });
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
    expect(res.body).not.toContain("secret internal detail");
  });
});

describe("framework errors keep their own status (not a blanket 500)", () => {
  let app: ApiServer;
  afterEach(async () => {
    await app.close();
  });

  /** A route that takes no body — pause, kill, logout, enable/disable. */
  function bodylessPostServer(): ApiServer {
    const app = makeServer([]);
    app.post("/control/pause", () => ({ tradingEnabled: false }));
    return app;
  }

  it("accepts a bodyless JSON POST — the shape every client actually sends", async () => {
    // content-type declares JSON, no body follows. Fastify default-rejects
    // this (FST_ERR_CTP_EMPTY_JSON_BODY); our parser treats it as no body,
    // because a route that needs none has nothing to complain about. Relying
    // on clients never doing this is not tenable — a cached bundle or a curl
    // call does it too.
    app = bodylessPostServer();
    const res = await app.inject({
      method: "POST",
      url: "/control/pause",
      headers: { "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tradingEnabled: false });
  });

  it("hands a body-requiring route undefined, so ITS validation reports", async () => {
    // The transport stops complaining; the route names the missing fields.
    app = makeServer([]);
    app.post("/needs-body", (request) => {
      if (request.body === undefined) throw new ValidationError("body required");
      return { ok: true };
    });
    const res = await app.inject({
      method: "POST",
      url: "/needs-body",
      headers: { "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("succeeds when no content-type is declared, as the client now sends", async () => {
    app = bodylessPostServer();
    const res = await app.inject({ method: "POST", url: "/control/pause" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tradingEnabled: false });
  });

  it("still reports malformed JSON as 400", async () => {
    app = bodylessPostServer();
    const res = await app.inject({
      method: "POST",
      url: "/control/pause",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });

    expect(res.statusCode).toBe(400);
  });

  it("names the failure instead of an opaque message", async () => {
    app = bodylessPostServer();
    const res = await app.inject({
      method: "POST",
      url: "/control/pause",
      headers: { "content-type": "application/json" },
    });
    expect(res.body).not.toContain("Internal server error");
    expect(res.body).not.toContain("INTERNAL_ERROR");
  });

  it("still answers a genuine handler throw opaquely with 500", async () => {
    // A bug in our code must not leak its message to the caller.
    app = makeServer([]);
    app.get("/boom", () => {
      throw new Error("secret internal detail");
    });
    const res = await app.inject({ method: "GET", url: "/boom" });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("secret internal detail");
    expect(res.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  });
});
