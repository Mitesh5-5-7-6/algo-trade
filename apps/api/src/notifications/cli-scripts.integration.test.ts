import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureIndexes,
  SettingsRepository,
  StrategiesRepository,
  StrategyExperimentsRepository,
  type MongoConnection,
} from "@neelkanth/db";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "../test-support/infra.js";
import { seedCandles } from "../test-support/candles.js";
import {
  emaStrategy,
  goldenBudget,
  historicalBars,
} from "../replay/test-support.js";
import { hypothesisFingerprint } from "../validation/hypothesis.js";
import { hypothesis } from "../validation/test-support.js";

/**
 * Task 16.9 (design §5.1 D10, §5.3 Q3): the CLIs tell what they kept, run
 * for real on scratch databases — after the result is kept, never for a dry
 * run. Telegram is left unset here, so each says it is off: delivery itself
 * is cli.test.ts's to prove. The CLIs run the BUILT code: `pnpm build` first.
 */

const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
const RESEARCH_DB = "neelkanth_it_cli_notify";
const PAPER_DB = "neelkanth_it_cli_notify_paper";
const SESSION = "2026-01-09";
const OFF =
  "notified     off — TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not both set";

let research: MongoProbe | undefined;
let paper: MongoProbe | undefined;

function run(script: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL(`../../scripts/${script}`, import.meta.url)),
      ...args,
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: {
        PATH: process.env["PATH"] ?? "",
        SystemRoot: process.env["SystemRoot"] ?? "",
        MONGO_URI,
      },
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** The line index of the first line starting with `label`, or -1. */
const lineOf = (out: string, label: string) =>
  out.split("\n").findIndex((l) => l.startsWith(label));

async function seedPaper(c: MongoConnection): Promise<void> {
  const db = c.db;
  await db.dropDatabase();
  await ensureIndexes(db);
  await seedCandles(db, await historicalBars([0, 1, 2, 3, 4]));
  const { allocatedCapital, limits } = goldenBudget();
  const strategy = emaStrategy();
  await new SettingsRepository(db).updateGlobal({
    marketHours: { open: "09:15", close: "15:30", squareOff: "15:12" },
    capitalAllocation: allocatedCapital,
    globalRiskLimits: limits,
    indexSymbols: ["NSE:TESTINDEX-INDEX"],
    breadthSymbols: strategy.symbols,
  });
  await new StrategiesRepository(db).create({
    ...strategy,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  });
}

beforeAll(async () => {
  research = await probeMongo(MONGO_URI, RESEARCH_DB, "cli notify (research)");
  paper = await probeMongo(MONGO_URI, PAPER_DB, "cli notify (paper)");
  if (research.reachable) {
    const db = research.connection.db;
    await db.dropDatabase();
    await ensureIndexes(db);
    const h = hypothesis({ hypothesisId: "H-0001" });
    await new StrategyExperimentsRepository(db).save({
      experimentId: "H-0001",
      kind: "HYPOTHESIS",
      createdAt: 1,
      fingerprint: hypothesisFingerprint(h),
      manifest: h,
      result: {},
    });
  }
  if (paper.reachable) await seedPaper(paper.connection);
}, 300_000);

afterAll(async () => {
  await closeProbe(research);
  await closeProbe(paper);
});

describe("the CLIs tell what they kept (16.9)", () => {
  it("validation.mts declare tells, after declaring", (ctx) => {
    if (research?.reachable !== true) return ctx.skip();
    const r = run("validation.mts", [
      "declare",
      "--hypothesis=H-0001",
      "--strategy=RSI",
      '--grid=[{},{"period":21}]',
      "--symbols=NSE:NIFTY50-INDEX",
      "--statement=RSI, as configured or slower",
      `--db=${RESEARCH_DB}`,
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(OFF);
    expect(lineOf(r.stdout, "notified")).toBeGreaterThan(
      lineOf(r.stdout, "declared"),
    );
  }, 120_000);

  it("validation.mts declare tells nothing when refused", (ctx) => {
    if (research?.reachable !== true) return ctx.skip();
    const r = run("validation.mts", [
      "declare",
      "--hypothesis=H-0999",
      "--strategy=RSI",
      "--symbols=NSE:NIFTY50-INDEX",
      "--statement=no such hypothesis",
      `--db=${RESEARCH_DB}`,
    ]);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("notified");
  }, 120_000);

  it("paper.mts report tells of a kept report, and not of a dry run", (ctx) => {
    if (paper?.reachable !== true) return ctx.skip();
    const dry = run("paper.mts", [
      "report",
      `--session=${SESSION}`,
      `--db=${PAPER_DB}`,
      "--dry-run",
    ]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).not.toContain("notified");

    const kept = run("paper.mts", [
      "report",
      `--session=${SESSION}`,
      `--db=${PAPER_DB}`,
    ]);
    expect(kept.status, kept.stderr).toBe(0);
    expect(kept.stdout).toMatch(/^kept {9}psr_2026-01-09_\d+$/m);
    expect(kept.stdout).toContain(OFF);
    expect(lineOf(kept.stdout, "notified")).toBeGreaterThan(
      lineOf(kept.stdout, "kept"),
    );
  }, 120_000);
});
