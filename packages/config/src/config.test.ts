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

  it("takes the FYERS PIN as 4 to 6 digits, an empty value as unset (2026-11-19)", () => {
    expect(loadConfig({ ...validEnv, FYERS_PIN: "1234" }).FYERS_PIN).toBe(
      "1234",
    );
    expect(
      loadConfig({ ...validEnv, FYERS_PIN: "" }).FYERS_PIN,
    ).toBeUndefined();
    expect(loadConfig(validEnv).FYERS_PIN).toBeUndefined();
    expect(() => loadConfig({ ...validEnv, FYERS_PIN: "12ab" })).toThrow(
      ConfigValidationError,
    );
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

  it("checks paper mode too — paper trading runs on the real FYERS feed", () => {
    // Paper mode simulates execution but takes prices from the live feed
    // (plan/19 §2), so the OAuth round trip is load-bearing there as well. A
    // wrong callback path used to pass validation in paper mode and then fail
    // as a broker login that silently never completes.
    expect(() =>
      loadConfig({
        ...validEnv,
        FYERS_REDIRECT_URL: "http://localhost:3000/whatever",
      }),
    ).toThrow(/must end in \/auth\/fyers\/callback/);
  });

  it("accepts a correct callback path in paper mode", () => {
    expect(
      loadConfig({
        ...validEnv,
        FYERS_REDIRECT_URL: "http://localhost:4000/auth/fyers/callback",
      }).FYERS_REDIRECT_URL,
    ).toBe("http://localhost:4000/auth/fyers/callback");
  });

  it("stays optional — an unset redirect URL is not an error in paper mode", () => {
    expect(loadConfig(validEnv).FYERS_REDIRECT_URL).toBeUndefined();
  });
});

describe("Telegram notifications (Phase 16)", () => {
  const BOT = "123456789:AAH-example_token";

  it("is off when neither is set — not an error", () => {
    const config = loadConfig(validEnv);
    expect(config.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(config.TELEGRAM_CHAT_ID).toBeUndefined();
  });

  it("accepts a bot and a chat together, including a group's negative id", () => {
    const config = loadConfig({
      ...validEnv,
      TELEGRAM_BOT_TOKEN: BOT,
      TELEGRAM_CHAT_ID: "-1001234567890",
    });
    expect(config.TELEGRAM_CHAT_ID).toBe("-1001234567890");
  });

  it("refuses a bot without a chat, and a chat without a bot", () => {
    expect(() => loadConfig({ ...validEnv, TELEGRAM_BOT_TOKEN: BOT })).toThrow(
      /TELEGRAM_CHAT_ID/,
    );
    expect(() =>
      loadConfig({ ...validEnv, TELEGRAM_CHAT_ID: "12345" }),
    ).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("reads empty values as unset", () => {
    const config = loadConfig({
      ...validEnv,
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
      TELEGRAM_TRADES_CHAT_ID: "",
    });
    expect(config.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(config.TELEGRAM_TRADES_CHAT_ID).toBeUndefined();
  });

  it("takes an optional trades chat beside the operations chat (16.8)", () => {
    const both = {
      ...validEnv,
      TELEGRAM_BOT_TOKEN: BOT,
      TELEGRAM_CHAT_ID: "-1001234567890",
    };
    expect(
      loadConfig({ ...both, TELEGRAM_TRADES_CHAT_ID: "@neelkanth_trades" })
        .TELEGRAM_TRADES_CHAT_ID,
    ).toBe("@neelkanth_trades");
    expect(loadConfig(both).TELEGRAM_TRADES_CHAT_ID).toBeUndefined();
  });

  it("refuses a trades chat without an operations chat, or not a chat", () => {
    expect(() =>
      loadConfig({ ...validEnv, TELEGRAM_TRADES_CHAT_ID: "-100987" }),
    ).toThrow(/TELEGRAM_TRADES_CHAT_ID/);
    expect(() =>
      loadConfig({
        ...validEnv,
        TELEGRAM_BOT_TOKEN: BOT,
        TELEGRAM_CHAT_ID: "-100123",
        TELEGRAM_TRADES_CHAT_ID: "trades room",
      }),
    ).toThrow(ConfigValidationError);
  });

  it("refuses values that cannot be a bot token or a chat", () => {
    expect(() =>
      loadConfig({
        ...validEnv,
        TELEGRAM_BOT_TOKEN: "not-a-token",
        TELEGRAM_CHAT_ID: "12345",
      }),
    ).toThrow(ConfigValidationError);
    expect(() =>
      loadConfig({
        ...validEnv,
        TELEGRAM_BOT_TOKEN: BOT,
        TELEGRAM_CHAT_ID: "my chat",
      }),
    ).toThrow(ConfigValidationError);
  });
});

describe("FYERS_WEBHOOK_SECRET", () => {
  it("reads an empty value as unset, not as a zero-length secret", () => {
    expect(
      loadConfig({ ...validEnv, FYERS_WEBHOOK_SECRET: "" })
        .FYERS_WEBHOOK_SECRET,
    ).toBeUndefined();
  });

  it("rejects a secret too short to be worth having", () => {
    expect(() =>
      loadConfig({ ...validEnv, FYERS_WEBHOOK_SECRET: "short" }),
    ).toThrow(ConfigValidationError);
  });

  describe("the research service (design §6.1 D16)", () => {
    const URL = "https://research.example.com";
    const TOKEN = "r".repeat(32);

    it("is optional: unset, the API boots without it", () => {
      const config = loadConfig({ ...validEnv });
      expect(config.RESEARCH_API_URL).toBeUndefined();
      expect(config.RESEARCH_API_TOKEN).toBeUndefined();
    });

    it("takes an address and a long secret together", () => {
      const config = loadConfig({
        ...validEnv,
        RESEARCH_API_URL: URL,
        RESEARCH_API_TOKEN: TOKEN,
      });
      expect(config.RESEARCH_API_URL).toBe(URL);
      expect(config.RESEARCH_API_TOKEN).toBe(TOKEN);
    });

    it("refuses one without the other, naming the missing one", () => {
      expect(() => loadConfig({ ...validEnv, RESEARCH_API_URL: URL })).toThrow(
        /RESEARCH_API_TOKEN/,
      );
      expect(() =>
        loadConfig({ ...validEnv, RESEARCH_API_TOKEN: TOKEN }),
      ).toThrow(/RESEARCH_API_URL/);
    });

    it("refuses a short secret, and reads empty as unset", () => {
      expect(() =>
        loadConfig({
          ...validEnv,
          RESEARCH_API_URL: URL,
          RESEARCH_API_TOKEN: "short",
        }),
      ).toThrow(/RESEARCH_API_TOKEN/);
      const config = loadConfig({
        ...validEnv,
        RESEARCH_API_URL: "",
        RESEARCH_API_TOKEN: "",
      });
      expect(config.RESEARCH_API_URL).toBeUndefined();
    });
  });
});
