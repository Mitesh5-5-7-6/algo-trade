import { describe, expect, it } from "vitest";
import { platformEnv } from "./platform-env.js";

/**
 * The failure this guards against is silent from inside the process: the app
 * boots, logs "api ready", and the platform still reports no open ports,
 * because it was listening on the loopback interface of its own container.
 */
describe("platformEnv (PaaS port convention, plan/22 §2)", () => {
  it("binds the injected PORT on all interfaces", () => {
    const env = platformEnv({ PORT: "10000" });
    expect(env["API_PORT"]).toBe("10000");
    expect(env["API_HOST"]).toBe("0.0.0.0");
  });

  it("leaves a laptop environment alone — no PORT, no rewriting", () => {
    const env = platformEnv({ MONGO_URI: "mongodb://localhost" });
    expect(env["API_PORT"]).toBeUndefined();
    expect(env["API_HOST"]).toBeUndefined();
  });

  it("treats an empty PORT as absent rather than as port zero", () => {
    const env = platformEnv({ PORT: "" });
    expect(env["API_HOST"]).toBeUndefined();
  });

  it("never overrides an explicit API_PORT or API_HOST", () => {
    const env = platformEnv({
      PORT: "10000",
      API_PORT: "4000",
      API_HOST: "127.0.0.1",
    });
    expect(env["API_PORT"]).toBe("4000");
    expect(env["API_HOST"]).toBe("127.0.0.1");
  });

  it("does not mutate the environment it was handed", () => {
    const original = { PORT: "10000" };
    platformEnv(original);
    expect(original).toEqual({ PORT: "10000" });
  });
});
