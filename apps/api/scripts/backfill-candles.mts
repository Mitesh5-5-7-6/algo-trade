/**
 * Operator CLI for the historical backfill (design D6 entry point 2, task 1.10).
 *
 * This is what runs to produce the first research dataset. It is deliberately
 * manual: D6 rules out an automatic backfill at boot, because that would make
 * startup depend on a third-party API and could silently rewrite history on
 * every restart.
 *
 *   cd apps/api
 *   node --env-file=../../.env.local scripts/backfill-candles.mts \
 *     --from=2025-09-28 --to=2026-09-27 --max-days=<measured>
 *
 * `--max-days` is REQUIRED and has no default. It is §3.1 question 1, and it
 * is measured by `probe-fyers-history.mts` (task 1.8), not guessed: FYERS may
 * truncate a too-long range silently while still answering `s: "ok"`, so a
 * wrong value here produces a run that looks successful and a dataset that is
 * quietly short. Until the probe has been run, this script refuses to start —
 * which is the intended behaviour, not a limitation to work around.
 *
 * Optional:
 *   --max-calls=N                 hard ceiling on vendor calls this run
 *   --zero-volume-unavailable     once Q4 confirms index volume is filler
 *   --holidays=A,B                override the settings holiday list
 *   --special-sessions=A,B        weekend dates the exchange traded anyway
 *                                 (Budget 1 Feb, Diwali Muhurat)
 *   --days-per-range=N            days per fetched range (default: --max-days)
 *   --delay-ms=N                  gap between calls (default 250)
 *   --dry-run                     fetch and report, write nothing
 *
 * Exits non-zero when any range failed OR any symbol came back
 * PARTIAL_HISTORY — a short dataset that exits 0 is one the next script
 * treats as a complete year.
 *
 * Defaults to the `indexSymbols` in global settings (task 1.5: index-only), so
 * ingestion and the live feed cannot drift apart about which indices matter.
 *
 * Writes to Mongo. Re-running a completed range is a no-op that rewrites
 * identical values (D3, D6).
 */
import { MongoClient } from "mongodb";
import { FyersHistoryProvider, RateLimiter } from "@neelkanth/broker";
import {
  backfillSucceeded,
  formatBackfillReport,
  runHistoricalBackfill,
  // Built output, not src: Node type-stripping does not remap a .js
  // specifier onto a .ts file, and this script runs under plain node. Run
  // `pnpm build` first — the same rule the repository already has for
  // typecheck reading dist/.
} from "../dist/jobs/historical-backfill.js";
import type { Candle, CandleInterval } from "@neelkanth/core";

const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? "true"] as const;
    }),
);

function required(name: string): string {
  const value = args.get(name);
  if (value === undefined || value === "true")
    throw new Error(`--${name}=<value> is required`);
  return value;
}

const FROM = required("from");
const TO = required("to");
const MAX_DAYS = Number(required("max-days"));
const INTERVAL = (args.get("interval") ?? "5m") as CandleInterval;
const DELAY_MS = Number(args.get("delay-ms") ?? "250");
const DAYS_PER_RANGE = Number(args.get("days-per-range") ?? String(MAX_DAYS));
const DRY_RUN = args.get("dry-run") === "true";
const SYMBOLS = args.get("symbols")?.split(",").filter(Boolean);
/** Hard ceiling on vendor calls for this run. Default: unlimited. */
const MAX_CALLS = args.get("max-calls");
/** Set once §3.1 Q4 confirms index volume is meaningless. */
const ZERO_VOLUME_UNAVAILABLE = args.get("zero-volume-unavailable") === "true";
/** Weekend dates the exchange traded anyway (Budget, Muhurat). */
const SPECIAL_SESSIONS = new Set(
  args.get("special-sessions")?.split(",").filter(Boolean) ?? [],
);
/**
 * Holidays to use INSTEAD of the ones in global settings.
 *
 * For a scratch database that has no settings document. Against the real one
 * this stays unset, so ingestion and the live session cannot come to disagree
 * about which days existed.
 */
const HOLIDAYS_OVERRIDE = args.get("holidays")?.split(",").filter(Boolean);

if (!Number.isInteger(MAX_DAYS) || MAX_DAYS < 1)
  throw new Error(
    "--max-days must be a positive integer. Run scripts/probe-fyers-history.mts " +
      "(task 1.8) to measure it; do not guess.",
  );

async function main(): Promise<void> {
  const appId = process.env["FYERS_APP_ID"];
  if (!appId) throw new Error("FYERS_APP_ID is not set");
  const uri = process.env["MONGO_URI"];
  if (!uri) throw new Error("MONGO_URI is not set");

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();

  try {
    const db = client.db();
    const settings = await db
      .collection("settings")
      .findOne({ scope: "global" });
    const holidays = new Set(
      HOLIDAYS_OVERRIDE ??
        (settings?.["marketHolidays"] as string[] | undefined) ??
        [],
    );
    const symbols =
      SYMBOLS ?? (settings?.["indexSymbols"] as string[] | undefined) ?? [];
    if (symbols.length === 0)
      throw new Error(
        "no symbols: pass --symbols=A,B or set indexSymbols in global settings",
      );

    const token = await loadToken(db, appId);
    const candles = db.collection("candles");

    // The backfill's OWN limiter, never the live order path's. Design §7.2
    // accepted a shared budget; that is overridden, because a shared one
    // makes this job's four-thousandth call and a real exit order contend
    // for a single token with arrival order deciding which loses.
    const rateLimiter = new RateLimiter({
      minIntervalMs: DELAY_MS,
      maxConcurrent: 1,
      ...(MAX_CALLS === undefined || MAX_CALLS === "true"
        ? {}
        : { maxCalls: Number(MAX_CALLS) }),
    });

    const provider = new FyersHistoryProvider({
      appId,
      getToken: () => Promise.resolve(token),
      maxDaysPerRequest: MAX_DAYS,
      requestDelayMs: DELAY_MS,
      rateLimiter,
      holidays,
      specialSessions: SPECIAL_SESSIONS,
      zeroVolumeIsUnavailable: ZERO_VOLUME_UNAVAILABLE,
      ingestionVersion: Math.floor(Date.now() / 1000),
    });

    console.log(
      `backfill ${symbols.join(", ")} ${INTERVAL} ${FROM}..${TO} ` +
        `(pages of ${String(MAX_DAYS)}d, ${String(DELAY_MS)}ms apart)` +
        (DRY_RUN ? " [DRY RUN — nothing is written]" : ""),
    );
    if (holidays.size === 0)
      console.warn(
        "WARNING: no marketHolidays configured. Every exchange holiday in the " +
          "range will be reported as a trading day with no data.",
      );

    const report = await runHistoricalBackfill(
      { symbols, interval: INTERVAL, fromDate: FROM, toDate: TO },
      {
        history: provider,
        holidays,
        specialSessions: SPECIAL_SESSIONS,
        daysPerRange: DAYS_PER_RANGE,
        saveCandle: DRY_RUN
          ? () => Promise.resolve(true)
          : (candle) => upsertCandle(candles, candle as Candle),
        onProgress: (e) =>
          console.log(
            `  ${e.symbol} ${e.fromDate}..${e.toDate}: ${String(e.stored)} bars` +
              (e.rejected > 0 ? `, ${String(e.rejected)} rejected` : "") +
              (e.empty ? " (no data)" : ""),
          ),
      },
    );

    console.log(`\n${formatBackfillReport(report)}`);

    const partial = [...report.perSymbol.values()].filter(
      (row) => row.status !== "COMPLETE",
    );
    if (!backfillSucceeded(report)) {
      console.error("\nsome ranges failed — see FAILED lines above");
      process.exitCode = 1;
    } else if (partial.length > 0) {
      // A partial dataset that exits 0 is one a script will treat as a
      // complete year. The whole point of the label is that nobody has to
      // remember to read it.
      console.error(
        `\n${String(partial.length)} symbol(s) returned PARTIAL_HISTORY — ` +
          "do not describe this dataset by the range requested",
      );
      process.exitCode = 1;
    }
  } finally {
    await client.close();
  }
}

/**
 * The rank-conditional upsert (D3), inline rather than through
 * `CandlesRepository` so this script stays a thin operator tool with no
 * composition root to boot.
 */
async function upsertCandle(
  collection: import("mongodb").Collection,
  candle: Candle,
): Promise<boolean> {
  const RANK = {
    BROKER_HISTORICAL: 3,
    IMPORTED_DATA: 2,
    LIVE_TICK: 1,
    REPLAY: 0,
  };
  const rank = RANK[candle.source];
  try {
    const result = await collection.updateOne(
      {
        symbol: candle.symbol,
        interval: candle.interval,
        ts: candle.ts,
        $or: [
          { sourceRank: { $lte: rank } },
          { sourceRank: { $exists: false } },
        ],
      },
      { $set: { ...candle, sourceRank: rank } },
      { upsert: true },
    );
    return result.matchedCount > 0 || result.upsertedCount > 0;
  } catch (error) {
    // Duplicate key: a higher-ranked bar is already stored. That is the
    // precedence rule working, not a failure.
    if ((error as { code?: number }).code === 11000) return false;
    throw error;
  }
}

async function loadToken(
  db: import("mongodb").Db,
  _appId: string,
): Promise<string> {
  const envToken = process.env["FYERS_ACCESS_TOKEN"];
  if (envToken) return envToken;

  const keyHex = process.env["TOKEN_ENCRYPTION_KEY"];
  if (!keyHex)
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set and FYERS_ACCESS_TOKEN was not provided",
    );

  const user = await db.collection("users").findOne({});
  if (!user) throw new Error("no operator account in the users collection");
  const row = await db
    .collection("broker_tokens")
    .findOne({ userId: user["userId"] as string });
  if (!row)
    throw new Error(
      "no FYERS token stored — connect the broker from Settings first",
    );

  // Same AES-256-GCM layout BrokerTokensRepository writes: iv | authTag | ct.
  const { createDecipheriv } = await import("node:crypto");
  const data = Buffer.from(row["accessToken"] as string, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyHex, "hex"),
    data.subarray(0, 12),
  );
  decipher.setAuthTag(data.subarray(12, 28));
  return (
    decipher.update(data.subarray(28)).toString("utf8") + decipher.final("utf8")
  );
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  // Not process.exit(): on Windows it can tear down an in-flight fetch
  // handle mid-close and print a libuv assertion after the real error,
  // which reads like a second, worse failure.
  process.exitCode = 1;
});
