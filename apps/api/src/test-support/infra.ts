import { connectMongo, type MongoConnection } from "@neelkanth/db";

/**
 * Reachability guard for suites that need a real MongoDB (§0.4).
 *
 * A deliberate second copy of `packages/db/src/test-support/infra.ts`. A shared
 * workspace package is the tidier answer and is the right move once a third
 * consumer appears; introducing one mid-phase would mean a new package.json,
 * two tsconfigs, devDependency edits and a lockfile change, against rule 13.
 *
 * The problem this solves is not "tests fail without a database" — it is that
 * **"passed" and "not run" looked the same**. Seven suites died in `beforeAll`
 * on `ECONNREFUSED`, two skipped in silence, and the summary line that a reader
 * actually sees said `0 failed`. A suite that never executed is not evidence,
 * and Phase 0's acceptance criterion is "existing tests remain green" — a claim
 * nobody could check.
 *
 * So there are two modes with two different meanings:
 *
 * - **default** (`pnpm test`) — an unreachable database prints a banner and the
 *   suite skips. This is the developer loop; it must not require Docker.
 * - **strict** (`REQUIRE_INTEGRATION=1`, i.e. `pnpm test:integration`) — an
 *   unreachable database is a hard failure with a non-zero exit code.
 *
 * Phase sign-off cites the strict command, so the difference stops being a
 * reading-comprehension exercise and becomes an exit code.
 */

/** Set by `pnpm test:integration`; makes unreachable infrastructure fatal. */
export const STRICT = process.env["REQUIRE_INTEGRATION"] === "1";

/**
 * Databases an integration suite is permitted to touch.
 *
 * These suites call `dropDatabase()`. `connectMongo` falls back to the database
 * named IN the URI when no name is passed, so an operator exporting the real
 * `MONGO_URI` would have dropped production. Every suite must name an isolated
 * database, and this refuses the run if one does not.
 */
const ISOLATED = /^neelkanth_(it|ci)_/;

/** How long to wait for a connection before calling the database unreachable. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Discriminated on `reachable` so `if (!probe.reachable) return;` narrows
 * `connection` to defined. A boolean plus an optional field would have forced
 * a non-null assertion at every call site, which is the same lie moved.
 */
export type MongoProbe =
  | { readonly reachable: true; readonly connection: MongoConnection }
  | {
      readonly reachable: false;
      readonly connection: undefined;
      readonly reason: string;
    };

/**
 * Connect, or report honestly why not.
 *
 * Rejects rather than skipping when `dbName` is not isolated: a misdirected
 * drop is not a condition to degrade gracefully around, and it must fail the
 * same way in both modes.
 */
export async function probeMongo(
  uri: string,
  dbName: string,
  suite: string,
): Promise<MongoProbe> {
  if (!ISOLATED.test(dbName)) {
    throw new Error(
      `${suite}: refusing to run against database "${dbName}" — integration ` +
        "suites drop their database and may only target neelkanth_it_* or " +
        "neelkanth_ci_*",
    );
  }

  try {
    const connection = await withTimeout(
      connectMongo(uri, dbName),
      PROBE_TIMEOUT_MS,
    );
    return { reachable: true, connection };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (STRICT) {
      throw new Error(
        `${suite}: MongoDB unreachable and REQUIRE_INTEGRATION=1 — ${reason}`,
      );
    }
    announce(suite, reason, uri, dbName);
    return { reachable: false, connection: undefined, reason };
  }
}

/**
 * The connection, or skip this test.
 *
 * `ctx.skip()` aborts, so the throw after it is unreachable at runtime and
 * exists only to satisfy the return type — the same shape the Redis suite has
 * used since it was written.
 */
export function requireMongo(
  probe: MongoProbe,
  ctx: { skip: () => void },
): MongoConnection {
  if (!probe.reachable) {
    ctx.skip();
    throw new Error("unreachable");
  }
  return probe.connection;
}

/**
 * Close whatever the probe opened.
 *
 * Optional-chained on purpose. Every one of these suites declared
 * `let connection: MongoConnection` and closed it unconditionally, and vitest
 * runs `afterAll` even when `beforeAll` threw — so each failure emitted a
 * second, louder `Cannot read properties of undefined (reading 'close')` that
 * buried the real `ECONNREFUSED`. Two indistinguishable causes for one symptom
 * is exactly what Phase 0 exists to remove.
 */
export async function closeProbe(probe: MongoProbe | undefined): Promise<void> {
  if (probe?.reachable === true) await probe.connection.close();
}

/** One unmissable block per skipped suite, on stderr. */
function announce(
  suite: string,
  reason: string,
  uri: string,
  dbName: string,
): void {
  const line = "#".repeat(74);
  process.stderr.write(
    `\n${line}\n` +
      `INTEGRATION SUITE NOT RUN — ${suite}\n` +
      `  These tests were NOT EXECUTED. Skipped is not passed.\n` +
      `  reason : ${reason}\n` +
      `  target : ${redact(uri)} → database "${dbName}"\n` +
      `  fix    : docker compose -f docker-compose.test.yml up -d\n` +
      `           or set MONGO_URI to a scratch database (never a production URI)\n` +
      `  strict : run \`pnpm test:integration\` to make this a hard failure\n` +
      `${line}\n\n`,
  );
}

/** Never print credentials, even to a local terminal. */
function redact(uri: string): string {
  return uri.replace(/\/\/[^@/]*@/, "//<credentials>@");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => {
        reject(new Error(`timed out after ${String(ms)}ms`));
      }, ms),
    ),
  ]);
}
