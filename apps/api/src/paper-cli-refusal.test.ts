import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Task 19.2 (design §8 D6): the paper report skill may reach the paper
 * database, so paper.mts must refuse every other one — before it connects,
 * so a Live database is never even contacted.
 *
 * Run for real, against a port nothing listens on: a CLI that connected
 * first would hang on server selection instead of refusing.
 */

const SCRIPT = fileURLToPath(new URL("../scripts/paper.mts", import.meta.url));

/** Nothing listens on port 1; a connection fails after 500 ms. */
const NOWHERE = (db: string) =>
  `mongodb://127.0.0.1:1/${db}?serverSelectionTimeoutMS=500`;

function run(args: string[], mongoUri: string) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
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
    `^refused: paper mode runs only on a paper database .* not "${db}"`,
  );

describe("paper.mts refuses a database that is not paper (19.2)", () => {
  for (const command of ["reports", "report", "provision"])
    it(`refuses ${command} against Live and research, in one line`, () => {
      for (const db of ["neelkanth_live", "neelkanth_research"]) {
        const r = run(
          [command, `--db=${db}`, "--dry-run"],
          NOWHERE("neelkanth_paper"),
        );
        expect(r.status).toBe(1);
        expect(r.stderr.trim()).toMatch(REFUSED(db));
      }
    });

  it("refuses the one MONGO_URI names when --db is absent", () => {
    const r = run(["reports"], NOWHERE("neelkanth"));
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toMatch(REFUSED("neelkanth"));
  });

  it("lets the paper and scratch databases through", () => {
    for (const db of ["neelkanth_paper", "neelkanth_it_paper"]) {
      const r = run(["reports", `--db=${db}`], NOWHERE("neelkanth"));
      // Past the guard: it fails on the connection, never with a refusal.
      expect(r.status).not.toBe(0);
      expect(r.stderr).not.toMatch(/paper mode runs only/);
    }
  });
});
