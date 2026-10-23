/**
 * Sweep the pattern detectors over the stored research dataset (Phase 5, 5.6).
 *
 *   node --env-file=../../.env.local scripts/sweep-patterns.mts \
 *     --symbols=NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX \
 *     --from=2025-09-29 --to=2026-09-28 [--interval=5m] \
 *     [--detectors='{"ORB_BREAKOUT":{"rangeMinutes":30}}'] \
 *     [--db=neelkanth_research] [--dns=1.1.1.1] [--dry-run]
 *
 * Reads `candles`; writes `patterns` and `pattern_observations` — the R&D
 * collections (ADR §10.1) — and nothing else (design D6). It writes only to
 * the research database or a scratch one; `--dry-run` keeps nothing anywhere.
 * The same arguments give the same fingerprint, every time.
 *
 * Runs the BUILT code: `pnpm build` first, as for replay.
 */
import dns from "node:dns";
import { MongoClient } from "mongodb";
import type { CandleInterval } from "@neelkanth/core";
import { sweepFromStore } from "../dist/patterns/sweep-store.js";

const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const eq = a.indexOf("=");
      return eq === -1
        ? ([a.slice(2), "true"] as const)
        : ([a.slice(2, eq), a.slice(eq + 1)] as const);
    }),
);

function required(name: string): string {
  const value = args.get(name);
  if (value === undefined || value === "true")
    throw new Error(`--${name}=<value> is required`);
  return value;
}
const list = (name: string): string[] =>
  (args.get(name) ?? "").split(",").filter(Boolean);

const symbols = list("symbols");
if (symbols.length === 0) throw new Error("--symbols=<a,b> is required");
const detectorsArg = args.get("detectors");
const dryRun = args.get("dry-run") === "true";

// Observations are research evidence: the research database, or a scratch
// one a test may drop. Never the trading database (D6).
const WRITABLE = /^(neelkanth_research|neelkanth_(it|ci)_.+)$/;

const resolvers = list("dns");
if (resolvers.length > 0) dns.setServers(resolvers);

const uri = process.env["MONGO_URI"];
if (!uri) throw new Error("MONGO_URI is not set");
const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(args.get("db"));
  if (!dryRun && !WRITABLE.test(db.databaseName))
    throw new Error(
      `refusing to write observations to "${db.databaseName}": only neelkanth_research or a scratch neelkanth_it_*/neelkanth_ci_* database (D6). Use --dry-run to sweep without writing.`,
    );

  const startedAt = Date.now();
  const report = await sweepFromStore(db, {
    symbols,
    interval: (args.get("interval") ?? "5m") as CandleInterval,
    fromDate: required("from"),
    toDate: required("to"),
    ...(detectorsArg === undefined
      ? {}
      : {
          detectors: JSON.parse(detectorsArg) as Record<string, unknown>,
        }),
    observedAt: startedAt,
    save: !dryRun,
  });

  console.log(`database     ${db.databaseName}`);
  console.log(
    `catalogue    ${dryRun ? "checked" : "registered"}: ${String(report.catalog.added.length)} new, ${String(report.catalog.known.length)} known`,
  );
  for (const s of report.symbols) {
    console.log(
      `${s.symbol}  ${String(s.bars)} bars, ${String(s.sessions)} sessions (${s.firstSession ?? "-"} .. ${s.lastSession ?? "-"})`,
    );
    console.log(`  found              ${JSON.stringify(s.found)}`);
    console.log(`  declined, volume   ${JSON.stringify(s.declinedForVolume)}`);
    console.log(`  skipped, warm-up   ${JSON.stringify(s.skippedForWarmup)}`);
    console.log(`  recorded           ${String(s.recorded)}`);
    console.log(`  fingerprint        ${s.fingerprint}`);
  }
  console.log(`fingerprint  ${report.fingerprint}`);
  console.log(
    dryRun
      ? "kept         nothing (dry run)"
      : `kept         ${String(report.symbols.reduce((n, s) => n + s.recorded, 0))} new observations`,
  );
  console.log(`took         ${String(Date.now() - startedAt)} ms`);
} finally {
  await client.close();
}
