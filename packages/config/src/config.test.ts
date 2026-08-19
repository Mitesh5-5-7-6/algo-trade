import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadConfig } from "./index.js";

const validEnv = {
  MONGO_URI: "mongodb://localhost:27017/neelkanth",
  REDIS_URL: "redis://localhost:6379",
  SESSION_SECRET: "s".repeat(32),
  TOKEN_ENCRYPTION_KEY: "a".repeat(64),
};

describe("loadConfig (plan/04 §6 fail-fast)", () => {
  it("parses a valid environment and applies documented defaults", () => {
    const config = loadConfig(validEnv);
    expect(config.NODE_ENV).toBe("development");
    expect(config.BROKER_MODE).toBe("paper");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.API_PORT).toBe(4000);
  });

  it("coerces numeric strings for ports", () => {
    expect(loadConfig({ ...validEnv, API_PORT: "8080" }).API_PORT).toBe(8080);
  });

  it("refuses to start on missing required vars, reporting ALL failures", () => {
    try {
      loadConfig({});
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const paths = (error as ConfigValidationError).issues.map(
        (issue) => issue.path,
      );
      expect(paths).toContain("MONGO_URI");
      expect(paths).toContain("REDIS_URL");
      expect(paths).toContain("SESSION_SECRET");
      expect(paths).toContain("TOKEN_ENCRYPTION_KEY");
    }
  });

  it("rejects a token-encryption key that is not 32 bytes hex (plan/24 §5)", () => {
    expect(() =>
      loadConfig({ ...validEnv, TOKEN_ENCRYPTION_KEY: "deadbeef" }),
    ).toThrow(ConfigValidationError);
  });

  it("rejects a short session secret", () => {
    expect(() => loadConfig({ ...validEnv, SESSION_SECRET: "short" })).toThrow(
      ConfigValidationError,
    );
  });

  it("requires FYERS credentials when BROKER_MODE=live (plan/05 §3 swap gate)", () => {
    expect(() => loadConfig({ ...validEnv, BROKER_MODE: "live" })).toThrow(
      /FYERS_APP_ID is required when BROKER_MODE=live/,
    );

    const live = loadConfig({
      ...validEnv,
      BROKER_MODE: "live",
      FYERS_APP_ID: "APP-100",
      FYERS_APP_SECRET: "secret",
      FYERS_REDIRECT_URL: "https://example.com/auth/fyers/callback",
    });
    expect(live.BROKER_MODE).toBe("live");
  });

  it("allows paper mode without FYERS credentials (fixture-driven dev, plan/28 §3)", () => {
    expect(loadConfig(validEnv).FYERS_APP_ID).toBeUndefined();
  });

  it("rejects unknown enum values rather than guessing", () => {
    expect(() => loadConfig({ ...validEnv, BROKER_MODE: "simulated" })).toThrow(
      ConfigValidationError,
    );
  });
});

describe("FYERS redirect URL (must match the route apps/api serves)", () => {
  const liveEnv = {
    ...validEnv,
    BROKER_MODE: "live",
    FYERS_APP_ID: "APP-100",
    FYERS_APP_SECRET: "secret",
  };

  it("accepts the callback path the API actually registers", () => {
    const config = loadConfig({
      ...liveEnv,
      FYERS_REDIRECT_URL: "https://api.example.com/auth/fyers/callback",
    });
    expect(config.FYERS_REDIRECT_URL).toBe(
      "https://api.example.com/auth/fyers/callback",
    );
  });

  it("rejects an /api-prefixed path — a 404 that would surface only at login", () => {
    expect(() =>
      loadConfig({
        ...liveEnv,
        FYERS_REDIRECT_URL: "https://api.example.com/api/auth/fyers/callback",
      }),
    ).toThrow(/must end in \/auth\/fyers\/callback/);
  });

  it("rejects a path that exists nowhere in the codebase", () => {
    expect(() =>
      loadConfig({
        ...liveEnv,
        FYERS_REDIRECT_URL: "http://localhost:3000/api/broker/fyers/callback",
      }),
    ).toThrow(/must end in \/auth\/fyers\/callback/);
  });

  it("leaves paper mode alone — the check gates on live, like the credentials", () => {
    expect(
      loadConfig({
        ...validEnv,
        FYERS_REDIRECT_URL: "http://localhost:3000/whatever",
      }).FYERS_REDIRECT_URL,
    ).toBe("http://localhost:3000/whatever");
  });
});

describe("FYERS_WEBHOOK_SECRET", () => {
  it("reads an empty value as unset, not as a zero-length secret", () => {
    expect(loadConfig({ ...validEnv, FYERS_WEBHOOK_SECRET: "" })
      .FYERS_WEBHOOK_SECRET).toBeUndefined();
  });

  it("rejects a secret too short to be worth having", () => {
    expect(() =>
      loadConfig({ ...validEnv, FYERS_WEBHOOK_SECRET: "short" }),
    ).toThrow(ConfigValidationError);
  });
});
