import { describe, expect, it } from "vitest";
import { checkReadiness, type DependencyCheck } from "./health.js";

const up = (name: string): DependencyCheck => ({
  name,
  probe: () => Promise.resolve(true),
});
const down = (name: string): DependencyCheck => ({
  name,
  probe: () => Promise.resolve(false),
});
const throwing = (name: string): DependencyCheck => ({
  name,
  probe: () => Promise.reject(new Error("boom")),
});

describe("checkReadiness (plan/23 §4)", () => {
  it("is ready only when every dependency is up", async () => {
    const report = await checkReadiness([up("mongo"), up("redis")]);
    expect(report.ready).toBe(true);
    expect(report.dependencies).toEqual({ mongo: "up", redis: "up" });
  });

  it("is unready if any dependency is down, and names which", async () => {
    const report = await checkReadiness([up("mongo"), down("redis")]);
    expect(report.ready).toBe(false);
    expect(report.dependencies).toEqual({ mongo: "up", redis: "down" });
  });

  it("treats a throwing probe as down — fail-closed (plan/14 §9)", async () => {
    const report = await checkReadiness([up("mongo"), throwing("redis")]);
    expect(report.ready).toBe(false);
    expect(report.dependencies["redis"]).toBe("down");
  });

  it("is ready with no dependencies (vacuous truth)", async () => {
    const report = await checkReadiness([]);
    expect(report.ready).toBe(true);
  });
});
