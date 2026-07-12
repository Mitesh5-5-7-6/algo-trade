import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runGoldenPipeline, type GoldenRecord } from "./pipeline.js";
import { goldenFixture } from "./fixture.js";

const goldenPath = fileURLToPath(
  new URL("./golden-record.json", import.meta.url),
);

/**
 * The signature test of the system (plan/27 §4): run the whole machine over a
 * recorded fixture and compare EVERY signal, risk decision, order, fill,
 * position, and PnL against a committed golden record. Any diff fails the
 * build — an *intended* behavior change updates the record in the same PR,
 * making the consequence visible in review as a diff of trades. This is
 * Chapter 02 Principle 1 (determinism) turned into CI.
 *
 * To regenerate after an intended change: `UPDATE_GOLDEN=1 pnpm --filter
 * @neelkanth/api test` and review the resulting diff.
 */
describe("golden run (plan/27 §4)", () => {
  it("reproduces the committed golden record exactly", async () => {
    const record = await runGoldenPipeline(goldenFixture());
    const actual = `${JSON.stringify(record, null, 2)}\n`;

    if (process.env["UPDATE_GOLDEN"] === "1" || !existsSync(goldenPath)) {
      writeFileSync(goldenPath, actual);
    }
    expect(actual).toBe(readFileSync(goldenPath, "utf8"));
  });

  it("is deterministic — two runs produce identical records", async () => {
    const a = await runGoldenPipeline(goldenFixture());
    const b = await runGoldenPipeline(goldenFixture());
    expect(a).toEqual(b);
  });

  it("produces meaningful activity — signals, orders, and a realized result", async () => {
    const record: GoldenRecord = await runGoldenPipeline(goldenFixture());
    expect(record.signals.length).toBeGreaterThan(0);
    expect(record.orders.length).toBeGreaterThan(0);
    expect(record.positions.length).toBeGreaterThan(0);
    // Every order traces back to a recorded signal + risk decision.
    const signalIds = new Set(record.signals.map((s) => s.signalId));
    for (const order of record.orders) {
      expect(signalIds.has(order.signalId)).toBe(true);
    }
  });
});
