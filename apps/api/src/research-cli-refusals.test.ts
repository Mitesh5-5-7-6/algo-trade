import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Task 19.3 (design §8 D3): the replay and validation CLIs refuse any
 * database but the research one or a scratch one — before they connect, so
 * the operator skills that wrap them can only reach research data.
 *
 * Run for real, against a port nothing listens on: a CLI that connected
 * first would hang on server selection instead of refusing.
 */

const script = (name: string) =>
  fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));

/** Nothing listens on port 1; a connection fails after 500 ms. */
const NOWHERE = (db: string) =>
  `mongodb://127.0.0.1:1/${db}?serverSelectionTimeoutMS=500`;

function run(cli: string, args: string[], mongoUri: string) {
  const result = spawnSync(process.execPath, [script(cli), ...args], {
    env: {
      PATH: process.env["PATH"] ?? "",
      SystemRoot: process.env["SystemRoot"] ?? "",
      MONGO_URI: mongoUri,
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: result.status, stderr: result.stderr };
}

const REFUSED = (db: string) =>
  new RegExp(
    `refusing "${db}": .*only neelkanth_research or a scratch neelkanth_it_\\*/neelkanth_ci_\\* database`,
  );

describe("replay.mts refuses a database it must not touch (19.3)", () => {
  it("refuses one named by --db, before connecting", () => {
    const r = run(
      "replay.mts",
      ["--db=neelkanth_paper"],
      NOWHERE("neelkanth_research"),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(REFUSED("neelkanth_paper"));
  });

  it("refuses the one MONGO_URI names when --db is absent", () => {
    for (const db of ["neelkanth", "neelkanth_live"]) {
      const r = run("replay.mts", [], NOWHERE(db));
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(REFUSED(db));
    }
  });

  it("lets the research and scratch databases through", () => {
    for (const db of ["neelkanth_research", "neelkanth_it_replay"]) {
      const r = run("replay.mts", [`--db=${db}`], NOWHERE("neelkanth"));
      // Past the guard: it fails later, on a missing argument or the
      // connection, but never with a refusal.
      expect(r.status).not.toBe(0);
      expect(r.stderr).not.toMatch(/refusing/);
    }
  });
});

/**
 * The historical backfill writes the research dataset, so it takes the same
 * rule. Before it had one, it wrote to whichever database MONGO_URI named —
 * and the operator's env file names the paper database, where a year of
 * broker history would have landed beside the paper session's own bars.
 */
describe("backfill-candles.mts writes history only to research", () => {
  it("refuses a trading database named by --db, before connecting", () => {
    const r = run(
      "backfill-candles.mts",
      ["--db=neelkanth_paper"],
      NOWHERE("neelkanth_research"),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(REFUSED("neelkanth_paper"));
  });

  it("refuses the one MONGO_URI names when --db is absent", () => {
    for (const db of ["neelkanth_paper", "neelkanth", "neelkanth_live"]) {
      const r = run("backfill-candles.mts", [], NOWHERE(db));
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(REFUSED(db));
    }
  });

  it("lets --db choose research or scratch over the one MONGO_URI names", () => {
    for (const db of ["neelkanth_research", "neelkanth_it_backfill"]) {
      const r = run(
        "backfill-candles.mts",
        [`--db=${db}`],
        NOWHERE("neelkanth_paper"),
      );
      // Past the guard: it stops on the first missing argument instead.
      expect(r.status).toBe(1);
      expect(r.stderr).not.toMatch(/refusing/);
      expect(r.stderr).toMatch(/--from=<value> is required/);
    }
  });
});

describe("validation.mts refuses on every command, reads too (19.3)", () => {
  for (const command of ["list", "verdict", "declare", "walk-forward"])
    it(`refuses ${command} against a trading database, in one line`, () => {
      const r = run(
        "validation.mts",
        [command, "--db=neelkanth_paper"],
        NOWHERE("neelkanth_research"),
      );
      expect(r.status).toBe(1);
      expect(r.stderr.trim()).toMatch(
        new RegExp(`^refused: ${REFUSED("neelkanth_paper").source}$`),
      );
    });

  it("refuses the one MONGO_URI names when --db is absent", () => {
    const r = run("validation.mts", ["list"], NOWHERE("neelkanth"));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(REFUSED("neelkanth"));
  });

  it("lets the research database through", () => {
    const r = run(
      "validation.mts",
      ["list", "--db=neelkanth_research"],
      NOWHERE("neelkanth"),
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toMatch(/refusing/);
  });
});

/**
 * Task 17.6 (design §6.1 D7): setup odds reads the research dataset and
 * keeps its runs beside the other experiments — never in a trading database.
 */
describe("odds.mts refuses a database it must not touch (17.6)", () => {
  const SETUP_REFUSED = (db: string) =>
    new RegExp(
      `refusing "${db}": setup odds reads and writes only neelkanth_research or a scratch neelkanth_it_\\*/neelkanth_ci_\\* database`,
    );

  it("refuses one named by --db, before connecting", () => {
    const r = run(
      "odds.mts",
      ["--db=neelkanth_paper"],
      NOWHERE("neelkanth_research"),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(SETUP_REFUSED("neelkanth_paper"));
  });

  it("refuses the one MONGO_URI names when --db is absent, dry run or not", () => {
    for (const db of ["neelkanth", "neelkanth_live", "neelkanth_paper"]) {
      const r = run("odds.mts", ["--dry-run"], NOWHERE(db));
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(SETUP_REFUSED(db));
    }
  });

  it("lets the research and scratch databases through", () => {
    for (const db of ["neelkanth_research", "neelkanth_it_odds"]) {
      const r = run("odds.mts", [`--db=${db}`], NOWHERE("neelkanth"));
      // Past the guard: it fails later, on a missing argument or the
      // connection, but never with a refusal.
      expect(r.status).not.toBe(0);
      expect(r.stderr).not.toMatch(/refusing/);
    }
  });
});
