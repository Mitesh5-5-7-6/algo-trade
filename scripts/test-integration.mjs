#!/usr/bin/env node
/**
 * The strict test run (§0.4) — `pnpm test:integration`.
 *
 * `pnpm test` skips unreachable integration suites so the developer loop does
 * not require Docker. That is the right default and the wrong thing to sign a
 * phase off with, because a skipped suite and a passing suite produce the same
 * `0 failed`. This command removes the ambiguity: with `REQUIRE_INTEGRATION=1`
 * an unreachable database is a hard failure, so "did the integration tests run"
 * becomes an exit code rather than a question about scrollback.
 *
 * Two guards before anything starts:
 *
 *   1. The resolved database must be `neelkanth_it*` / `neelkanth_ci*`. These
 *      suites call `dropDatabase()`, and the most natural way to make them
 *      reachable — exporting the real `MONGO_URI` — pointed them at production.
 *   2. `--force`, because turbo caches `test` and a replayed green log is the
 *      purest form of "not run" wearing "passed" as a costume.
 */
import { spawnSync } from "node:child_process";

const ISOLATED = /^neelkanth_(it|ci)/;

/** The database segment of a Mongo URI — what the driver would open. */
function databaseOf(uri) {
  const queryAt = uri.indexOf("?");
  const base = queryAt === -1 ? uri : uri.slice(0, queryAt);
  const schemeEnd = base.indexOf("://");
  const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const pathStart = base.indexOf("/", authorityStart);
  return pathStart === -1 ? "" : base.slice(pathStart + 1);
}

function die(message) {
  process.stderr.write(`\ntest:integration — ${message}\n\n`);
  process.exit(2);
}

const mongoUri = process.env.MONGO_URI;
if (mongoUri !== undefined && mongoUri !== "") {
  const database = databaseOf(mongoUri);
  if (!ISOLATED.test(database)) {
    die(
      `MONGO_URI resolves to database "${database}".\n` +
        "  These suites DROP their database. Point MONGO_URI at a scratch\n" +
        "  database named neelkanth_it* or neelkanth_ci*, never a real one.",
    );
  }
}

process.stderr.write(
  "\ntest:integration — strict mode. Unreachable infrastructure is a FAILURE.\n" +
    `  MONGO_URI : ${mongoUri === undefined || mongoUri === "" ? "unset (defaults to localhost)" : `database "${databaseOf(mongoUri)}"`}\n` +
    `  REDIS_URL : ${process.env.REDIS_URL ?? "unset (defaults to localhost)"}\n\n`,
);

const result = spawnSync("pnpm", ["exec", "turbo", "run", "test", "--force"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, REQUIRE_INTEGRATION: "1" },
});

process.exit(result.status ?? 1);
