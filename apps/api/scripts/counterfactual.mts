/**
 * Evaluate every strategy against the stored research dataset (Phase 6, 6.6).
 *
 *   node --env-file=../../.env.local scripts/counterfactual.mts \
 *     --symbols=NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX \
 *     --index-symbols=NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX \
 *     --from=2025-09-29 --to=2026-09-28 --capital=1000000 [--seed=0] \
 *     [--window=0] [--regime-index=NSE:NIFTY50-INDEX] \
 *     [--strategy-params='{"EMA_CROSSOVER":{"quantity":50}}'] \
 *     [--db=neelkanth_research] [--dns=1.1.1.1] [--dry-run]
 *
 * Reads `candles` and writes one `strategy_experiments` document, and nothing
 * else (design D7) — only to the research database or a scratch one;
 * `--dry-run` keeps nothing anywhere. Prints, for every pattern, how each
 * strategy behaved when it occurred. The same arguments give the same
 * fingerprint, every time.
 *
 * Runs the BUILT code: `pnpm build` first, as for replay.
 */
import dns from "node:dns";
import { MongoClient } from "mongodb";
import { DEFAULT_GLOBAL_SETTINGS } from "@neelkanth/db";
import type { CandleInterval } from "@neelkanth/core";
import { counterfactualFromStore } from "../dist/counterfactual/store.js";
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

const symbols = list("symbols");
if (symbols.length === 0) throw new Error("--symbols=<a,b> is required");
const dryRun = args.get("dry-run") === "true";
const strategyParams = args.get("strategy-params");

// Research evidence: the research database, or a scratch one (D7).
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
      `refusing to write an experiment to "${db.databaseName}": only neelkanth_research or a scratch neelkanth_it_*/neelkanth_ci_* database (D7). Use --dry-run to evaluate without writing.`,
    );

  const startedAt = Date.now();
  const { run, saved } = await counterfactualFromStore(db, {
    symbols,
    indexSymbols: list("index-symbols"),
    interval: (args.get("interval") ?? "5m") as CandleInterval,
    fromDate: required("from"),
    toDate: required("to"),
    hours: DEFAULT_GLOBAL_SETTINGS.marketHours,
    allocatedCapital: Number(required("capital")),
    limits: DEFAULT_GLOBAL_SETTINGS.globalRiskLimits,
    seed: Number(args.get("seed") ?? "0"),
    ...(strategyParams === undefined
      ? {}
      : {
          strategyParams: JSON.parse(strategyParams) as Record<
            string,
            Record<string, unknown>
          >,
        }),
    regime: {
      ...DEFAULT_REGIME_MODEL,
      symbol: args.get("regime-index") ?? DEFAULT_REGIME_MODEL.symbol,
    },
    attribution: {
      ...DEFAULT_ATTRIBUTION_MODEL,
      windowBars: Number(args.get("window") ?? "0"),
    },
    experimentId: `cf_${String(startedAt)}`,
    createdAt: startedAt,
    save: !dryRun,
  });

  const { manifest, matrix, patterns } = run;
  console.log(`database     ${db.databaseName}`);
  console.log(
    `dataset      ${manifest.dataset.symbols.join(", ")} ${manifest.dataset.interval}, ${String(manifest.dataset.days.length)} days (${manifest.dataset.days[0] ?? "-"} .. ${manifest.dataset.days.at(-1) ?? "-"}), ${String(manifest.dataset.bars)} bars`,
  );
  console.log(
    `models       regime ${manifest.models.regime.kind} v${manifest.models.regime.version} on ${manifest.models.regime.symbol}; attribution v${manifest.models.attribution.version}, window ${String(manifest.models.attribution.windowBars)} bars`,
  );
  for (const s of manifest.strategies)
    console.log(
      s.eligible
        ? `evaluated    ${s.type} on ${s.symbol} (${s.strategyVersion}): ${String(s.trades)} trades`
        : `excluded     ${s.type} on ${s.symbol}: ${s.exclusion.kind} — ${s.exclusion.reason}`,
    );
  for (const p of patterns)
    console.log(
      `patterns     ${p.symbol} found ${JSON.stringify(p.found)}; declined for volume ${JSON.stringify(Object.fromEntries(Object.entries(p.declinedForVolume).filter(([, n]) => n > 0)))}`,
    );

  const fmt = (n: number | null, digits = 2): string =>
    n === null ? "-" : n.toFixed(digits);
  console.log("");
  console.log(
    "pattern                 strategy        occ   entered signalled holding  flat |   n  win%  expectancy        net   drawdown",
  );
  for (const r of matrix.filter(
    (m) => m.symbol === "ALL" && m.regime === "ALL",
  )) {
    const rel = r.relations;
    console.log(
      [
        r.patternId.padEnd(23),
        r.strategyType.padEnd(15),
        (r.occurrences === null ? "-" : String(r.occurrences)).padStart(5),
        (rel === null ? "-" : String(rel.ENTERED)).padStart(9),
        (rel === null ? "-" : String(rel.SIGNALLED)).padStart(9),
        (rel === null ? "-" : String(rel.HOLDING)).padStart(7),
        (rel === null ? "-" : String(rel.FLAT)).padStart(5),
        "|",
        String(r.trades.n).padStart(3),
        (r.trades.winRate === null
          ? "-"
          : (r.trades.winRate * 100).toFixed(0)
        ).padStart(5),
        fmt(r.trades.expectancy).padStart(11),
        fmt(r.trades.net).padStart(10),
        fmt(r.trades.maxDrawdown).padStart(10),
      ].join(" "),
    );
  }
  console.log("");
  console.log(
    `rows         ${String(matrix.length)} (by symbol and regime in the kept document)`,
  );
  console.log(`fingerprint  ${run.fingerprint}`);
  console.log(
    dryRun
      ? "kept         nothing (dry run)"
      : `kept         ${saved ? "strategy_experiments" : "NOT kept — experiment id taken"}`,
  );
  console.log(`took         ${String(Date.now() - startedAt)} ms`);
} finally {
  await client.close();
}
