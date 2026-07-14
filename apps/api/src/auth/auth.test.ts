import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { Position, RiskLimits, SessionContext } from "@neelkanth/core";
import {
  connectMongo,
  ensureIndexes,
  UsersRepository,
  type MongoConnection,
} from "@neelkanth/db";
import { createLogger } from "@neelkanth/logger";
import { buildServer, type ApiServer } from "../server.js";
import { registerControlPlane } from "../control-plane/routes.js";
import type { RuntimeControls } from "../control-plane/controls.js";
import { SessionStore, type SessionKV } from "./sessions.js";
import { LoginRateLimiter, type RateLimitKV } from "./rate-limit.js";
import { createOperator } from "./bootstrap.js";
import { createStepUpVerifier, registerAuthGuard } from "./plugin.js";
import { registerAuthRoutes } from "./routes.js";

const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/neelkanth_auth_test";
const EMAIL = "op@neelkanth.io";
const PASSWORD = "sup3r-secret-pass";

/** One in-memory KV backing both the session store and the rate limiter. */
function fakeKV(): SessionKV & RateLimitKV {
  const values = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    set(key, value) {
      values.set(key, value);
      return Promise.resolve();
    },
    get(key) {
      return Promise.resolve(values.get(key) ?? null);
    },
    del(key) {
      values.delete(key);
      sets.delete(key);
      return Promise.resolve();
    },
    sadd(key, member) {
      let set = sets.get(key);
      if (set === undefined) {
        set = new Set();
        sets.set(key, set);
      }
      set.add(member);
      return Promise.resolve();
    },
    srem(key, member) {
      sets.get(key)?.delete(member);
      return Promise.resolve();
    },
    smembers(key) {
      return Promise.resolve([...(sets.get(key) ?? [])]);
    },
    incr(key) {
      const next = Number(values.get(key) ?? "0") + 1;
      values.set(key, String(next));
      return Promise.resolve(next);
    },
    expire() {
      return Promise.resolve();
    },
    ttl() {
      return Promise.resolve(-1);
    },
  };
}

function fakeRuntime(): RuntimeControls {
  return {
    setTradingEnabled() {
      /* noop */
    },
    enableStrategy() {
      return Promise.resolve();
    },
    disableStrategy() {
      /* noop */
    },
    applyGlobalSettings() {
      /* noop */
    },
    getOpenPositions: (): Position[] => [],
    realizedPnl: () => 0,
    unrealizedPnl: () => 0,
    session: (): SessionContext => ({ phase: "open", minutesSinceOpen: 0 }),
  };
}

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

let connection: MongoConnection;
let app: ApiServer;
let users: UsersRepository;

beforeAll(async () => {
  connection = await connectMongo(MONGO_URI, "neelkanth_it_auth");
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);
});

afterAll(async () => {
  await connection.close();
});

beforeEach(async () => {
  await connection.db.collection("users").deleteMany({});
  await connection.db.collection("settings").deleteMany({});
  users = new UsersRepository(connection.db);
  await createOperator(users, { email: EMAIL, password: PASSWORD });

  const kv = fakeKV();
  const sessions = new SessionStore(kv, 1800, 3600);
  const rateLimiter = new LoginRateLimiter(kv, {
    maxFailures: 5,
    windowSeconds: 900,
    lockoutSeconds: 900,
  });

  app = buildServer({ logger: silentLogger(), readinessChecks: [] });
  registerAuthGuard(app, { sessions, users, secureCookies: false });
  registerAuthRoutes(app, {
    users,
    sessions,
    rateLimiter,
    secureCookies: false,
  });
  registerControlPlane(app, {
    db: connection.db,
    runtime: fakeRuntime(),
    verifyStepUp: createStepUpVerifier(users),
  });
});

afterEach(async () => {
  await app.close();
});

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const header = res.headers["set-cookie"];
  const raw = Array.isArray(header) ? String(header[0]) : String(header);
  return raw.split(";", 1)[0] ?? raw;
}

function login(password = PASSWORD) {
  return app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: EMAIL, password },
  });
}

describe("authentication guard (plan/21 §4)", () => {
  it("blocks the money surface without a session but allows health probes", async () => {
    const guarded = await app.inject({ method: "GET", url: "/positions" });
    expect(guarded.statusCode).toBe(401);
    expect(guarded.json<{ error: { code: string } }>().error.code).toBe(
      "UNAUTHORIZED",
    );

    const health = await app.inject({ method: "GET", url: "/health/live" });
    expect(health.statusCode).toBe(200);
  });

  it("rejects bad credentials and accepts good ones with a cookie", async () => {
    expect((await login("wrong")).statusCode).toBe(401);

    const ok = await login();
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ role: string }>().role).toBe("operator");
    expect(String(ok.headers["set-cookie"])).toContain("HttpOnly");
  });

  it("lets an authenticated session read, then logout ends it", async () => {
    const cookie = sessionCookie(await login());

    const read = await app.inject({
      method: "GET",
      url: "/positions",
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);

    await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie },
    });

    const after = await app.inject({
      method: "GET",
      url: "/positions",
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it("fails closed when the account is disabled mid-session", async () => {
    const cookie = sessionCookie(await login());
    await connection.db
      .collection("users")
      .updateOne({ email: EMAIL }, { $set: { status: "disabled" } });

    const res = await app.inject({
      method: "GET",
      url: "/positions",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("brute-force lockout (plan/21 §2)", () => {
  it("locks the account after repeated failures", async () => {
    for (let i = 0; i < 5; i++)
      expect((await login("nope")).statusCode).toBe(401);
    const locked = await login("nope");
    expect(locked.statusCode).toBe(429);
    // Even the correct password is refused while locked out.
    expect((await login()).statusCode).toBe(429);
  });
});

describe("step-up re-auth (plan/21 §5)", () => {
  it("gates resume behind a password re-entry", async () => {
    const cookie = sessionCookie(await login());

    const noPw = await app.inject({
      method: "POST",
      url: "/control/resume",
      headers: { cookie },
    });
    expect(noPw.statusCode).toBe(403);
    expect(noPw.json<{ error: { code: string } }>().error.code).toBe(
      "STEP_UP_REQUIRED",
    );

    const wrongPw = await app.inject({
      method: "POST",
      url: "/control/resume",
      headers: { cookie },
      payload: { stepUpPassword: "wrong" },
    });
    expect(wrongPw.statusCode).toBe(403);

    const good = await app.inject({
      method: "POST",
      url: "/control/resume",
      headers: { cookie },
      payload: { stepUpPassword: PASSWORD },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ tradingEnabled: true });
  });

  it("requires step-up to loosen a limit, but not to tighten it", async () => {
    const cookie = sessionCookie(await login());
    const current = (
      await app.inject({ method: "GET", url: "/settings", headers: { cookie } })
    ).json<{ globalRiskLimits: RiskLimits }>();

    const loosened: RiskLimits = {
      ...current.globalRiskLimits,
      maxPositionSize: current.globalRiskLimits.maxPositionSize + 1,
    };
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/settings",
          headers: { cookie },
          payload: { globalRiskLimits: loosened },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/settings",
          headers: { cookie },
          payload: { globalRiskLimits: loosened, stepUpPassword: PASSWORD },
        })
      ).statusCode,
    ).toBe(200);

    const tightened: RiskLimits = {
      ...current.globalRiskLimits,
      maxPositionSize: Math.max(
        1,
        current.globalRiskLimits.maxPositionSize - 1,
      ),
    };
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/settings",
          headers: { cookie },
          payload: { globalRiskLimits: tightened },
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe("bootstrap (plan/21 §6)", () => {
  it("refuses to create a second operator", async () => {
    const result = await createOperator(users, {
      email: "second@neelkanth.io",
      password: "another-pass",
    });
    expect(result).toEqual({
      created: false,
      reason: "an operator account already exists",
    });
  });
});
