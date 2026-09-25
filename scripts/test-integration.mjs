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
 *   3. `--concurrency=1`. Every package running at once opens dozens of
 *      simultaneous TLS handshakes to one hosted Mongo and one hosted Redis,
 *      and shared free-tier instances do not survive it — the observed failure
 *      was "unable to verify the first certificate" from suites that connect
 *      fine on their own. Serial is slower and it is the only honest way to
 *      get a reproducible answer out of shared infrastructure.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/**
 * Credentials come from `.env.test.local` when it exists — gitignored by the
 * `.env.*` rule.
 *
 * There is no dotenv in this repository, so without this the only way to supply
 * a hosted URI is to export it in the shell, where it lands in shell history
 * and in the environment of every other process. A file read by exactly one
 * script is the narrower blast radius, and it keeps a live credential out of
 * any transcript.
 *
 * An explicit shell variable always wins, so CI — which sets them directly —
 * is never overridden by a stray file.
 */
function loadEnvFile(path) {
  if (!existsSync(path)) return [];
  const loaded = [];
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 &&
      (value.at(0) === '"' || value.at(0) === "'") &&
      value.at(-1) === value.at(0);
    if (quoted) value = value.slice(1, -1);
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

const loaded = loadEnvFile(".env.test.local");

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

/** Never print credentials, even to a local terminal — logs outlive sessions. */
function redact(url) {
  return url === undefined || url === ""
    ? undefined
    : url.replace(/\/\/[^@/]*@/, "//<credentials>@");
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
    (loaded.length > 0
      ? `  loaded    : ${loaded.join(", ")} from .env.test.local\n`
      : "") +
    `  MONGO_URI : ${mongoUri === undefined || mongoUri === "" ? "unset (defaults to localhost)" : `database "${databaseOf(mongoUri)}"`}\n` +
    `  REDIS_URL : ${redact(process.env.REDIS_URL) ?? "unset (defaults to localhost)"}\n\n`,
);

const result = spawnSync(
  "pnpm",
  ["exec", "turbo", "run", "test", "--force", "--concurrency=1"],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      REQUIRE_INTEGRATION: "1",
      // Some outbound TLS on this machine is intercepted by a proxy whose root
      // CA lives in the Windows certificate store, not in the CA list Node
      // bundles. The symptom is an INTERMITTENT "unable to verify the first
      // certificate" from Atlas — the same URI connecting fine seconds earlier.
      // Node names the fix in the error text.
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--use-system-ca"]
        .filter(Boolean)
        .join(" "),
    },
  },
);

process.exit(result.status ?? 1);
