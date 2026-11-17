import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { istDateKey } from "@neelkanth/core";
import {
  ensureIndexes,
  PaperReconciliationsRepository,
  RiskLogsRepository,
  SettingsRepository,
  SignalsRepository,
  StrategiesRepository,
  StrategyCandidatesRepository,
  TradesRepository,
  type MongoConnection,
} from "@neelkanth/db";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "./test-support/infra.js";
import { seedCandles } from "./test-support/candles.js";
import { orbDay, ORB_DAY_SYMBOL } from "./odds/test-support.js";
import {
  emaStrategy,
  goldenBudget,
  historicalBars,
} from "./replay/test-support.js";
import { runHistoricalReplay } from "./replay/run.js";
import { DEFAULT_REGIME_MODEL } from "./counterfactual/regime.js";
import { walkForwardFromStore } from "./backtest/walk-forward-store.js";
import { reportSessionFromStore } from "./paper/session-report-store.js";

/**
 * Task 19.5 — each operator skill, held to its CLI on scratch databases.
 *
 * A skill is read by Claude, so this cannot test Claude's wording. It tests
 * what that wording stands on, from each SKILL.md as written, so a new skill
 * is picked up without touching this file:
 *
 *   - every command line runs, on seeded scratch data, and is not refused
 *   - the same command prints the same thing twice — numbers that can be
 *     quoted verbatim
 *   - every field its Output section documents is one the CLI prints
 *   - with --db pointed at a trading database, it is refused, and refused
 *     again however the database is named: a refused command stays refused
 *
 * The CLIs run the BUILT code: `pnpm build` first.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SKILLS = join(ROOT, ".claude", "skills");
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
/** Nothing listens on port 1: a refusal must come before any connection. */
const NOWHERE = "mongodb://127.0.0.1:1/neelkanth?serverSelectionTimeoutMS=500";

const RESEARCH_DB = "neelkanth_it_skills_research";
const PAPER_DB = "neelkanth_it_skills_paper";
const SYM = "NSE:TESTCO-EQ";
const INDEX = "NSE:TESTINDEX-INDEX";
const HOURS = { open: "09:15", close: "15:30", squareOff: "15:12" };
const SESSION = "2026-01-09";

/** What the operator would supply for each placeholder, here. */
const VALUES: Record<string, string> = {
  type: "EMA_CROSSOVER",
  params: "{}",
  symbols: SYM,
  "index-symbols": INDEX,
  from: "2026-01-05",
  to: SESSION,
  capital: String(goldenBudget().allocatedCapital),
  candidate: "SC-0001",
  "walk-forward": "wf_1",
  session: SESSION,
  // setup-odds (19.4): a long from 09:40 on the Monday after ODDS_SESSIONS.
  symbol: ORB_DAY_SYMBOL,
  side: "LONG",
  entry: "20080",
  stop: "20000",
  target: "20180",
  date: "2026-03-16",
  time: "09:40",
  "rule-type": "ORB",
  // fo-scan (19.4): a weekday the calendar opens; the scratch store holds no
  // daily bars, so every underlying is reported as having none.
  "scan-date": "2026-11-17",
};

/**
 * Full 75-bar sessions for setup-odds, which draws only from those — the
 * golden day stops at 15:08, so it holds none.
 */
const ODDS_SESSIONS = [
  ...orbDay("2026-03-02", "TARGET"),
  ...orbDay("2026-03-03", "STOP"),
  ...orbDay("2026-03-04", "NEITHER"),
  ...orbDay("2026-03-05", "QUIET"),
  ...orbDay("2026-03-06", "TARGET"),
  ...orbDay("2026-03-09", "STOP"),
  ...orbDay("2026-03-10", "TARGET"),
  ...orbDay("2026-03-11", "QUIET"),
];

interface Command {
  line: string;
  dir: string;
  /** Given an env file, so it reaches MongoDB; otherwise it reaches none. */
  envFile: boolean;
  script: string;
  args: string[];
}

/** `[cd <dir> && ]node [--env-file=…] scripts/<cli> …`, as check-skills allows. */
function parse(line: string): Command {
  const cd = /^cd\s+(\S+)\s+&&\s+/.exec(line);
  const tokens = (cd === null ? line : line.slice(cd[0].length)).split(/\s+/);
  let i = 1;
  const envFile = tokens[i]?.startsWith("--env-file=") === true;
  if (envFile) i += 1;
  const args = tokens.slice(i + 1).map((t) =>
    t.replace(/"?<([\w.-]+)>"?/g, (_, name: string) => {
      const value = VALUES[name];
      if (value === undefined)
        throw new Error(`${line}: no test value for <${name}> — add one`);
      return value;
    }),
  );
  return { line, dir: cd?.[1] ?? ".", envFile, script: tokens[i] ?? "", args };
}

/** The `sh` lines of a SKILL.md — the commands it runs. */
function commandsOf(text: string): Command[] {
  return [...text.matchAll(/^```sh\n([\s\S]*?)^```/gm)]
    .flatMap((m) => (m[1] ?? "").split("\n"))
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map(parse);
}

/**
 * The fields its Output tables document: the backticked names in each row's
 * first cell, except rows whose meaning starts "Only" — printed when a
 * condition holds, not always.
 */
function documentedFields(text: string): string[] {
  const output = /^## Output\n([\s\S]*?)^## /m.exec(text)?.[1] ?? "";
  const fields: string[] = [];
  for (const row of output.split("\n")) {
    if (!row.startsWith("|") || /^\|[\s|:-]+\|$/.test(row)) continue;
    const [name = "", meaning = ""] = row
      .slice(1)
      .split("|")
      .map((c) => c.trim());
    if (meaning.startsWith("Only")) continue;
    for (const m of name.matchAll(/`([^`]+)`/g)) fields.push(m[1] ?? "");
  }
  return fields;
}

/** The trading database a --db would be swapped for, and the scratch one. */
function scratchFor(db: string): string {
  return db === "neelkanth_paper" ? PAPER_DB : RESEARCH_DB;
}
function tradingFor(db: string): string[] {
  return db === "neelkanth_paper"
    ? ["neelkanth", "neelkanth_research"]
    : ["neelkanth", "neelkanth_paper"];
}

function withDb(args: string[], db: (current: string) => string): string[] {
  return args.map((a) =>
    a.startsWith("--db=") ? `--db=${db(a.slice("--db=".length))}` : a,
  );
}

function run(c: Command, args: string[], mongoUri: string) {
  const result = spawnSync(process.execPath, [c.script, ...args], {
    cwd: join(ROOT, c.dir),
    env: {
      PATH: process.env["PATH"] ?? "",
      SystemRoot: process.env["SystemRoot"] ?? "",
      // The machine's trust store, not a credential: a CLI that reaches the
      // broker's public files (fo-scan) fails TLS without it on a network
      // that inspects HTTPS, exactly as it would in the operator's shell.
      ...(process.env["NODE_EXTRA_CA_CERTS"] === undefined
        ? {}
        : { NODE_EXTRA_CA_CERTS: process.env["NODE_EXTRA_CA_CERTS"] }),
      ...(c.envFile ? { MONGO_URI: mongoUri } : {}),
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const skills = readdirSync(SKILLS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const text = readFileSync(join(SKILLS, d.name, "SKILL.md"), "utf8");
    return {
      name: d.name,
      commands: commandsOf(text),
      fields: documentedFields(text),
    };
  });

let research: MongoProbe | undefined;
let paper: MongoProbe | undefined;

async function seedResearch(c: MongoConnection): Promise<void> {
  const db = c.db;
  await db.dropDatabase();
  await ensureIndexes(db);
  const offsets: number[] = [];
  for (let d = -4; d <= 176; d += 1) {
    const day = new Date(Date.UTC(2026, 0, 5 + d)).getUTCDay();
    if (day !== 0 && day !== 6) offsets.push(d);
  }
  await seedCandles(
    db,
    await historicalBars(offsets, (d) => 1 + (d % 7) * 0.03 + (d % 11) * 0.01),
  );
  // Another symbol, so the two seeds cannot collide on a bar.
  await seedCandles(db, ODDS_SESSIONS);
  await new StrategyCandidatesRepository(db).save({
    candidateId: "SC-0001",
    createdAt: 1,
    strategyType: "EMA_CROSSOVER",
    grid: [{}, { fast: 5, slow: 13 }],
    symbols: [SYM],
    hypothesisId: "H-0001",
    statement: "EMA_CROSSOVER, as configured or faster",
    fingerprint: "c".repeat(64),
  });
  await walkForwardFromStore(
    db,
    "SC-0001",
    {
      interval: "5m",
      hours: HOURS,
      ...goldenBudget(),
      seed: 0,
      regime: { ...DEFAULT_REGIME_MODEL, symbol: INDEX },
      minTrainingTrades: 10,
    },
    { save: true, walkForwardId: "wf_1", createdAt: 9 },
  );
}

/** A paper session as the runtime writes it (as in 14.5), and its kept report. */
async function seedPaper(c: MongoConnection): Promise<void> {
  const db = c.db;
  await db.dropDatabase();
  await ensureIndexes(db);
  const days = [0, 1, 2, 3, 4];
  const scale = (d: number) => 1 + (d % 5) * 0.04 + d * 0.01;
  await seedCandles(db, await historicalBars(days, scale));
  const { allocatedCapital, limits } = goldenBudget();
  const strategy = emaStrategy();
  await new SettingsRepository(db).updateGlobal({
    marketHours: HOURS,
    capitalAllocation: allocatedCapital,
    globalRiskLimits: limits,
    indexSymbols: [INDEX],
    breadthSymbols: strategy.symbols,
  });
  await new StrategiesRepository(db).create({
    ...strategy,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  });
  const { trail } = await runHistoricalReplay({
    strategy,
    candles: await historicalBars(days, scale),
    hours: HOURS,
    ...goldenBudget(),
    seed: 0,
  });
  const today = <T extends { ts?: number; entryTime?: number }>(rows: T[]) =>
    rows.filter((r) => istDateKey(r.ts ?? r.entryTime ?? 0) === SESSION);
  for (const s of today(trail.signals))
    await new SignalsRepository(db).insert(s);
  for (const l of today(trail.riskLogs))
    await new RiskLogsRepository(db).insert(l);
  for (const t of today(trail.trades)) await new TradesRepository(db).save(t);
  await new PaperReconciliationsRepository(db).insert({
    runId: "recon_close",
    session: SESSION,
    at: "CLOSE",
    ts: Date.UTC(2026, 0, 9, 10, 1),
    clean: true,
    mismatches: 0,
  });
  await reportSessionFromStore(
    db,
    { session: SESSION, generatedAt: 1 },
    { save: true, reportId: "psr_it" },
  );
}

beforeAll(async () => {
  if (!existsSync(join(ROOT, "apps", "api", "dist", "replay", "store.js")))
    throw new Error("apps/api/dist is missing — run pnpm build first");
  research = await probeMongo(MONGO_URI, RESEARCH_DB, "skills (research)");
  paper = await probeMongo(MONGO_URI, PAPER_DB, "skills (paper)");
  if (research.reachable) await seedResearch(research.connection);
  if (paper.reachable) await seedPaper(paper.connection);
}, 600_000);

afterAll(async () => {
  await closeProbe(research);
  await closeProbe(paper);
});

const reachable = () =>
  research?.reachable === true && paper?.reachable === true;

describe("the skills found (19.5)", () => {
  it("are the four 19.1–19.3 added and 19.4's setup-odds and fo-scan, at least", () => {
    expect(skills.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        "board-status",
        "candidate-verdicts",
        "paper-report",
        "replay",
        "setup-odds",
        "fo-scan",
      ]),
    );
    for (const s of skills) {
      expect(s.commands.length, s.name).toBeGreaterThan(0);
      expect(s.fields.length, s.name).toBeGreaterThan(0);
    }
  });
});

for (const skill of skills)
  describe(`${skill.name} on scratch databases (19.5)`, () => {
    const outputs: string[] = [];

    for (const c of skill.commands)
      it(`runs, the same twice: ${c.line}`, (ctx) => {
        if (!reachable()) return ctx.skip();
        const args = withDb(c.args, scratchFor);
        const first = run(c, args, MONGO_URI);
        expect(first.stderr).not.toMatch(/refus/);
        expect(first.status, first.stderr).toBe(0);
        const second = run(c, args, MONGO_URI);
        expect(second.stdout).toBe(first.stdout);
        outputs.push(first.stdout);
      }, 300_000);

    it("prints every field its Output section documents", (ctx) => {
      if (!reachable() || outputs.length !== skill.commands.length)
        return ctx.skip();
      const printed = outputs.join("\n");
      const missing = skill.fields.filter(
        // A field is printed as a label: alone, or followed by a colon.
        (f) =>
          !new RegExp(`(^|\\s)${escape(f)}(?=[\\s:]|$)`, "m").test(printed),
      );
      expect(missing).toEqual([]);
    });

    for (const c of skill.commands.filter((x) =>
      x.args.some((a) => a.startsWith("--db=")),
    ))
      it(`stays refused on a trading database: ${c.line}`, () => {
        const named = c.args.find((a) => a.startsWith("--db=")) ?? "";
        for (const trading of tradingFor(named.slice("--db=".length))) {
          const r = run(
            c,
            withDb(c.args, () => trading),
            NOWHERE,
          );
          expect(r.status, `${trading}: ${r.stdout}`).toBe(1);
          expect(r.stderr).toMatch(/refus/);
          expect(r.stdout).toBe("");
        }
      }, 120_000);
  });
