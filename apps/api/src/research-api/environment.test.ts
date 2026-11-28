import { describe, expect, it } from "vitest";
import {
  databaseNameOf,
  loadResearchAi,
  loadResearchConfig,
  researchDatabaseProblem,
} from "./environment.js";

const TOKEN = "t".repeat(32);
const env = (over: Record<string, string | undefined> = {}) => ({
  MONGO_URI: "mongodb+srv://user:pw@cluster.example.net/neelkanth_research?x=1",
  RESEARCH_API_TOKEN: TOKEN,
  ...over,
});

describe("the research service's environment (17.8)", () => {
  it("serves the research database and scratch ones, and no other", () => {
    for (const ok of ["neelkanth_research", "neelkanth_it_x", "neelkanth_ci_1"])
      expect(researchDatabaseProblem(ok)).toBeNull();
    for (const refused of [
      "neelkanth",
      "neelkanth_paper",
      "neelkanth_live",
      "neelkanth_research_copy",
      "",
    ])
      expect(researchDatabaseProblem(refused)).toMatch(
        /refusing ".*": the research service reads and writes only neelkanth_research/,
      );
  });

  it("reads the database a URI names without connecting", () => {
    expect(databaseNameOf("mongodb://localhost:27017/neelkanth_it_a")).toBe(
      "neelkanth_it_a",
    );
    expect(
      databaseNameOf("mongodb+srv://u:p@c.example.net/neelkanth_paper?w=1"),
    ).toBe("neelkanth_paper");
    expect(databaseNameOf("mongodb://localhost:27017")).toBe("");
    expect(databaseNameOf("mongodb://localhost:27017/?w=1")).toBe("");
  });

  it("refuses a trading database by name, at load", () => {
    expect(() =>
      loadResearchConfig(
        env({ MONGO_URI: "mongodb://localhost:27017/neelkanth_paper" }),
      ),
    ).toThrow(/refusing "neelkanth_paper"/);
    expect(() =>
      loadResearchConfig(env({ MONGO_URI: "mongodb://localhost:27017" })),
    ).toThrow(/refusing ""/);
  });

  it("needs a long shared secret", () => {
    expect(() =>
      loadResearchConfig(env({ RESEARCH_API_TOKEN: "short" })),
    ).toThrow(/RESEARCH_API_TOKEN/);
    expect(() =>
      loadResearchConfig(env({ RESEARCH_API_TOKEN: undefined })),
    ).toThrow(/RESEARCH_API_TOKEN/);
  });

  it("binds localhost:4100 on a laptop, and a platform's PORT on every interface", () => {
    expect(loadResearchConfig(env())).toMatchObject({
      database: "neelkanth_research",
      host: "127.0.0.1",
      port: 4100,
      dns: [],
      logLevel: "info",
    });
    expect(loadResearchConfig(env({ PORT: "10000" }))).toMatchObject({
      host: "0.0.0.0",
      port: 10000,
    });
    // Its own names win over the platform's.
    expect(
      loadResearchConfig(
        env({
          PORT: "10000",
          RESEARCH_API_PORT: "4200",
          RESEARCH_API_HOST: "127.0.0.1",
          RESEARCH_DNS: "1.1.1.1,8.8.8.8",
        }),
      ),
    ).toMatchObject({
      host: "127.0.0.1",
      port: 4200,
      dns: ["1.1.1.1", "8.8.8.8"],
    });
  });
});

describe("the news pipeline's environment (operator decision 2026-11-28)", () => {
  it("runs the collector by default; NEWS_COLLECTOR=off stops it", () => {
    expect(loadResearchConfig(env()).newsCollector).toBe(true);
    expect(
      loadResearchConfig(env({ NEWS_COLLECTOR: "on" })).newsCollector,
    ).toBe(true);
    expect(loadResearchConfig(env({ NEWS_COLLECTOR: "" })).newsCollector).toBe(
      true,
    );
    expect(
      loadResearchConfig(env({ NEWS_COLLECTOR: "off" })).newsCollector,
    ).toBe(false);
    expect(() => loadResearchConfig(env({ NEWS_COLLECTOR: "maybe" }))).toThrow(
      /NEWS_COLLECTOR/,
    );
  });

  it("has no AI read without a provider, and says so", () => {
    expect(loadResearchConfig(env()).ai).toEqual({
      ai: null,
      note: "no AI key configured",
      forbidden: [],
    });
  });

  it("takes the provider, the model and that provider's key", () => {
    const config = loadResearchConfig(
      env({
        AGENT_PROVIDER: "gemini",
        AGENT_MODEL: "gemini-2.5-flash",
        GEMINI_API_KEY: "g-key",
        OPENAI_API_KEY: "o-key",
      }),
    );
    expect(config.ai).toEqual({
      ai: { provider: "gemini", model: "gemini-2.5-flash", apiKey: "g-key" },
      note: null,
      forbidden: [],
    });
    expect(
      loadResearchAi({
        AGENT_PROVIDER: "deepseek",
        AGENT_MODEL: "deepseek-chat",
        DEEPSEEK_API_KEY: "d-key",
      }).ai,
    ).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: "d-key",
    });
  });

  it("skips the read when the provider's key is missing, naming the variable", () => {
    expect(
      loadResearchConfig(
        env({
          AGENT_PROVIDER: "openai",
          AGENT_MODEL: "gpt-x",
          GEMINI_API_KEY: "g",
        }),
      ).ai,
    ).toEqual({
      ai: null,
      note: "no AI key configured (OPENAI_API_KEY is not set)",
      forbidden: [],
    });
  });

  it("refuses a provider it cannot speak to, and a provider without a model", () => {
    expect(() =>
      loadResearchConfig(
        env({ AGENT_PROVIDER: "anthropic", AGENT_MODEL: "x" }),
      ),
    ).toThrow(/AGENT_PROVIDER/);
    expect(() =>
      loadResearchConfig(
        env({ AGENT_PROVIDER: "gemini", GEMINI_API_KEY: "g" }),
      ),
    ).toThrow(/AGENT_MODEL: required when AGENT_PROVIDER is set/);
    expect(() => loadResearchAi({ AGENT_PROVIDER: "gemini" })).toThrow(
      /AGENT_MODEL/,
    );
  });

  it("disables the read — never the service — beside a broker or production secret, naming it but not its value", () => {
    const config = loadResearchConfig(
      env({
        AGENT_PROVIDER: "gemini",
        AGENT_MODEL: "gemini-2.5-flash",
        GEMINI_API_KEY: "g-key",
        FYERS_ACCESS_TOKEN: "fyers-secret-value",
        REDIS_URL: "redis://x",
      }),
    );
    expect(config.ai.ai).toBeNull();
    expect(config.ai.forbidden).toEqual(["FYERS_ACCESS_TOKEN", "REDIS_URL"]);
    expect(config.ai.note).toMatch(
      /^AI read disabled: the environment holds FYERS_ACCESS_TOKEN, REDIS_URL/,
    );
    expect(JSON.stringify(config.ai)).not.toContain("fyers-secret-value");
    // Everything else still loads.
    expect(config.database).toBe("neelkanth_research");
  });
});
