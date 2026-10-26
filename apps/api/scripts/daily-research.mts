/**
 * Research every completed trading day not yet reported (Phase 8, 8.6).
 *
 *   node --env-file=../../.env.local scripts/daily-research.mts \
 *     --symbols=NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX \
 *     --index-symbols=NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX \
 *     --from=2025-09-29 [--to=<today>] --capital=1000000 [--seed=0] \
 *     [--recompute-stale] [--lookback=5] [--window=0] \
 *     [--db=neelkanth_research] [--dns=1.1.1.1]
 *
 * Idempotent: run it nightly after the backfill and it reports only the days
 * that have closed since; run it twice and the second adds nothing. With
 * --recompute-stale it also recomputes, as new versions, every report whose
 * bars have since been revised (spec §5.8). Reads `candles`, writes
 * `research_reports`, and nothing else — only in the research database or a
 * scratch one (design D6). Outside the trading runtime, by design.
 *
 * Runs the BUILT code: `pnpm build` first.
 */
import dns from "node:dns";
import { MongoClient } from "mongodb";
import { DEFAULT_GLOBAL_SETTINGS } from "@neelkanth/db";
import { istDateKey, type CandleInterval } from "@neelkanth/core";
import { runDailyResearch } from "../dist/research/store.js";
import { DEFAULT_REGIME_MODEL } from "../dist/counterfactual/regime.js";
import { DEFAULT_ATTRIBUTION_MODEL } from "../dist/counterfactual/attribution.js";

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

const WRITABLE = /^(neelkanth_research|neelkanth_(it|ci)_.+)$/;
const resolvers = list("dns");
if (resolvers.length > 0) dns.setServers(resolvers);
const uri = process.env["MONGO_URI"];
if (!uri) throw new Error("MONGO_URI is not set");
const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(args.get("db"));
  if (!WRITABLE.test(db.databaseName))
    throw new Error(
      `refusing to write research to "${db.databaseName}": only neelkanth_research or a scratch neelkanth_it_*/neelkanth_ci_* database (D6)`,
    );
  const now = Date.now();
  const startedAt = Date.now();
  const out = await runDailyResearch(db, {
    symbols: list("symbols"),
    indexSymbols: list("index-symbols"),
    interval: (args.get("interval") ?? "5m") as CandleInterval,
    fromDate: required("from"),
    toDate: args.get("to") ?? istDateKey(now),
    hours: DEFAULT_GLOBAL_SETTINGS.marketHours,
    allocatedCapital: Number(required("capital")),
    limits: DEFAULT_GLOBAL_SETTINGS.globalRiskLimits,
    seed: Number(args.get("seed") ?? "0"),
    regime: {
      ...DEFAULT_REGIME_MODEL,
      symbol: args.get("regime-index") ?? DEFAULT_REGIME_MODEL.symbol,
    },
    attribution: {
      ...DEFAULT_ATTRIBUTION_MODEL,
      windowBars: Number(args.get("window") ?? "0"),
    },
    lookbackSessions: Number(args.get("lookback") ?? "5"),
    now,
    recomputeStale: args.get("recompute-stale") === "true",
  });
  console.log(`database     ${db.databaseName}`);
  console.log(
    `reported     ${String(out.reported.length)}${out.reported.length > 0 ? ` (${out.reported[0] ?? ""} .. ${out.reported.at(-1) ?? ""})` : ""}`,
  );
  console.log(
    `recomputed   ${String(out.recomputed.length)}${out.recomputed.length > 0 ? `: ${out.recomputed.join(", ")}` : ""}`,
  );
  console.log(`current      ${String(out.current)}`);
  console.log(`incomplete   ${out.incomplete.join(", ") || "-"}`);
  console.log(`took         ${String(Date.now() - startedAt)} ms`);
} finally {
  await client.close();
}
