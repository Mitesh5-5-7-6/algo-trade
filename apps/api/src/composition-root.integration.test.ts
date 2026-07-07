import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "@neelkanth/config";
import { createLogger } from "@neelkanth/logger";
import { connectMongo } from "@neelkanth/db";
import { bootstrap, type AppContext } from "./composition-root.js";

/**
 * Integration test for the composition root (plan/05 §3) against REAL Mongo.
 * Verifies the boot sequence wires a working server and that shutdown
 * (plan/22 §4) tears everything down cleanly — the shutdown path can't be
 * exercised via SIGTERM on Windows dev boxes, so we drive it directly here.
 *
 * Skips when Mongo is unreachable (local dev without it); CI's service
 * container always provides it.
 */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/neelkanth_ctx_test";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

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

function testConfig(): Config {
  return loadConfig({
    MONGO_URI,
    REDIS_URL,
    SESSION_SECRET: "s".repeat(40),
    TOKEN_ENCRYPTION_KEY: "a".repeat(64),
    // Port is irrelevant: the test drives the server via inject(), never listen().
    LOG_LEVEL: "fatal",
  });
}

let mongoAvailable = false;

beforeAll(async () => {
  try {
    const probe = await connectMongo(MONGO_URI);
    mongoAvailable = true;
    await probe.close();
  } catch {
    mongoAvailable = false;
  }
});

function requireMongo(ctx: { skip: () => void }): void {
  if (!mongoAvailable) {
    ctx.skip();
  }
}

describe("bootstrap (plan/05 §3 composition root)", () => {
  let context: AppContext | undefined;

  afterAll(async () => {
    if (context) await context.shutdown();
  });

  it("boots a working server and reports the readiness split honestly", async (ctx) => {
    requireMongo(ctx);
    context = await bootstrap(testConfig(), silentLogger());

    const live = await context.server.inject({
      method: "GET",
      url: "/health/live",
    });
    expect(live.statusCode).toBe(200);

    const ready = await context.server.inject({
      method: "GET",
      url: "/health/ready",
    });
    // Mongo is up; Redis may or may not be (down in local dev). Either way the
    // per-dependency report must include mongo:up.
    const body = ready.json<{ dependencies: Record<string, string> }>();
    expect(body.dependencies["mongo"]).toBe("up");
  });

  it("shuts down cleanly without throwing (plan/22 §4)", async (ctx) => {
    requireMongo(ctx);
    const local = await bootstrap(testConfig(), silentLogger());
    await expect(local.shutdown()).resolves.toBeUndefined();
  });
});
