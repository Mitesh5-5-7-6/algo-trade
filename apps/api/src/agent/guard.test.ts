import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertAgentEnvironment,
  assertResearchDatabase,
  forbiddenIn,
} from "./guard.js";

/** Task 11.5 (design D5): no secrets, the research database only. */
const OK = { ANTHROPIC_API_KEY: "k", MONGO_URI: "mongodb://x" };

describe("the secret guard (11.5, D5)", () => {
  it("lets the agent's own environment through", () => {
    expect(() => {
      assertAgentEnvironment({ ...OK, PATH: "/bin" });
    }).not.toThrow();
  });

  it("refuses every broker and production secret — naming them, never their values", () => {
    const trading = {
      ...OK,
      FYERS_APP_SECRET: "s3cr3t-value",
      FYERS_ACCESS_TOKEN: "t0ken-value",
      TOKEN_ENCRYPTION_KEY: "k",
      SESSION_SECRET: "k",
      NEELKANTH_OPERATOR_PASSWORD: "p",
      REDIS_URL: "redis://x",
      BROKER_MODE: "live",
    };
    expect(forbiddenIn(trading)).toEqual([
      "BROKER_MODE",
      "FYERS_ACCESS_TOKEN",
      "FYERS_APP_SECRET",
      "NEELKANTH_OPERATOR_PASSWORD",
      "REDIS_URL",
      "SESSION_SECRET",
      "TOKEN_ENCRYPTION_KEY",
    ]);
    let message = "";
    try {
      assertAgentEnvironment(trading);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(
      /^refusing to start: the environment holds BROKER_MODE, FYERS_ACCESS_TOKEN/,
    );
    expect(message).not.toContain("s3cr3t-value");
    expect(message).not.toContain("t0ken-value");
  });

  /** Exactly what .env.local holds today — the env file the research CLIs use. */
  it("refuses to run with the trading env file's variables", () => {
    const envLocal = Object.fromEntries(
      [
        "NEXT_PUBLIC_API_BASE",
        "NODE_ENV",
        "API_HOST",
        "API_PORT",
        "DASHBOARD_ORIGIN",
        "MONGO_URI",
        "REDIS_URL",
        "SESSION_SECRET",
        "TOKEN_ENCRYPTION_KEY",
        "BROKER_MODE",
        "FYERS_APP_ID",
        "FYERS_APP_SECRET",
        "FYERS_REDIRECT_URL",
        "FYERS_ACCESS_TOKEN",
        "LOG_LEVEL",
        "NEELKANTH_OPERATOR_EMAIL",
        "NEELKANTH_OPERATOR_PASSWORD",
      ].map((k) => [k, "x"]),
    );
    expect(() => {
      assertAgentEnvironment({ ...envLocal, ANTHROPIC_API_KEY: "k" });
    }).toThrow(/refusing to start/);
  });

  it("an empty variable is not a secret", () => {
    expect(forbiddenIn({ FYERS_APP_SECRET: "" })).toEqual([]);
  });

  it("refuses to start without a key or a database", () => {
    expect(() => {
      assertAgentEnvironment({ MONGO_URI: "m" });
    }).toThrow(/ANTHROPIC_API_KEY not set/);
    expect(() => {
      assertAgentEnvironment({});
    }).toThrow(/ANTHROPIC_API_KEY and MONGO_URI not set/);
  });
});

describe("the provider, chosen in the env file (11.6, D8)", () => {
  const M = { MONGO_URI: "m" };

  it("defaults to Anthropic, its model to ours", () => {
    expect(assertAgentEnvironment({ ...M, ANTHROPIC_API_KEY: "k" })).toEqual({
      provider: "anthropic",
      keyVariable: "ANTHROPIC_API_KEY",
      model: undefined,
    });
  });

  it("OpenAI and DeepSeek need their own key and a model the operator names", () => {
    expect(
      assertAgentEnvironment({
        ...M,
        AGENT_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "k",
        AGENT_MODEL: "x",
      }),
    ).toEqual({
      provider: "deepseek",
      keyVariable: "DEEPSEEK_API_KEY",
      model: "x",
    });
    expect(() =>
      assertAgentEnvironment({
        ...M,
        AGENT_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "k",
      }),
    ).toThrow(/AGENT_MODEL not set/);
    expect(() =>
      assertAgentEnvironment({
        ...M,
        AGENT_PROVIDER: "openai",
        AGENT_MODEL: "x",
        ANTHROPIC_API_KEY: "k",
      }),
    ).toThrow(/OPENAI_API_KEY not set/);
  });

  it("refuses a provider it does not know", () => {
    expect(() =>
      assertAgentEnvironment({
        ...M,
        AGENT_PROVIDER: "gemini",
        ANTHROPIC_API_KEY: "k",
      }),
    ).toThrow(/AGENT_PROVIDER "gemini" is none of anthropic, openai, deepseek/);
  });

  it("refuses a production secret whichever provider is chosen", () => {
    expect(() =>
      assertAgentEnvironment({
        ...M,
        AGENT_PROVIDER: "openai",
        OPENAI_API_KEY: "k",
        AGENT_MODEL: "x",
        FYERS_ACCESS_TOKEN: "t",
      }),
    ).toThrow(/holds FYERS_ACCESS_TOKEN/);
  });
});

describe("the research database only (11.5, D5)", () => {
  it("accepts research and scratch databases, refuses the rest", () => {
    for (const ok of [
      "neelkanth_research",
      "neelkanth_it_agent",
      "neelkanth_ci_1",
    ])
      expect(() => {
        assertResearchDatabase(ok);
      }).not.toThrow();
    for (const no of [
      "neelkanth",
      "neelkanth_live",
      "neelkanth_paper",
      "test",
      "neelkanth_research_x",
    ])
      expect(() => {
        assertResearchDatabase(no);
      }).toThrow(/refusing/);
  });
});

describe("the CLI checks before it connects (11.5)", () => {
  it("runs the guard before any import that could connect or read a key", () => {
    const script = readFileSync(
      fileURLToPath(new URL("../../scripts/agent.mts", import.meta.url)),
      "utf8",
    );
    const guard = script.indexOf("assertAgentEnvironment(process.env);");
    expect(guard).toBeGreaterThan(0);
    for (const later of [
      'await import("mongodb")',
      'await import("@anthropic-ai/sdk")',
      "new MongoClient(",
      "assertResearchDatabase(db.databaseName)",
    ])
      expect(script.indexOf(later)).toBeGreaterThan(guard);
    // Nothing but the guard is imported statically.
    expect([...script.matchAll(/^import\s/gm)]).toHaveLength(1);
  });
});
