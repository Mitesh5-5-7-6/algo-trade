import { describe, expect, it } from "vitest";
import {
  databaseNameOf,
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
