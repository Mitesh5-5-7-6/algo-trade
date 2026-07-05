import { describe, expect, it } from "vitest";
import { componentLogger, createLogger } from "./index.js";

/** Collect emitted JSON lines synchronously for assertions. */
function captureLogger(level: "info" | "debug" = "info") {
  const lines: string[] = [];
  const logger = createLogger({
    level,
    name: "test",
    destination: {
      write(chunk: string) {
        lines.push(chunk);
        return true;
      },
    },
  });
  const parsed = () =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const firstLine = () => {
    const [line] = parsed();
    if (line === undefined) throw new Error("no log line captured");
    return line;
  };
  return { logger, parsed, firstLine };
}

describe("createLogger (plan/23 §3)", () => {
  it("emits structured JSON with name, level label, and message", () => {
    const { logger, firstLine } = captureLogger();
    logger.info({ orderId: "ord_1" }, "order placed");
    expect(firstLine()).toMatchObject({
      name: "test",
      level: "info",
      msg: "order placed",
      orderId: "ord_1",
    });
  });

  it("redacts secrets at top level and nested — enforced in config, not call sites", () => {
    const { logger, firstLine } = captureLogger();
    logger.info(
      {
        accessToken: "fyers-token-XYZ",
        broker: { refreshToken: "refresh-XYZ", name: "fyers" },
        user: { password: "hunter2" },
        sessionId: "sess-123",
      },
      "connected",
    );
    const line = firstLine();
    expect(line["accessToken"]).toBe("[REDACTED]");
    expect((line["broker"] as Record<string, unknown>)["refreshToken"]).toBe(
      "[REDACTED]",
    );
    expect((line["broker"] as Record<string, unknown>)["name"]).toBe("fyers");
    expect((line["user"] as Record<string, unknown>)["password"]).toBe(
      "[REDACTED]",
    );
    expect(line["sessionId"]).toBe("[REDACTED]");
    expect(JSON.stringify(line)).not.toContain("fyers-token-XYZ");
    expect(JSON.stringify(line)).not.toContain("hunter2");
  });

  it("suppresses lines below the configured level", () => {
    const { logger, parsed } = captureLogger("info");
    logger.debug("dev noise");
    logger.info("lifecycle fact");
    expect(parsed()).toHaveLength(1);
  });

  it("componentLogger stamps the per-subsystem component field", () => {
    const { logger, firstLine } = captureLogger();
    componentLogger(logger, "engine.risk").warn(
      { correlationId: "sig_1" },
      "daily loss at 80% of limit",
    );
    const line = firstLine();
    expect(line["component"]).toBe("engine.risk");
    expect(line["correlationId"]).toBe("sig_1");
  });
});
