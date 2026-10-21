/**
 * Replay one strategy over the stored research dataset (Phase 4, task 4.8).
 *
 *   node --env-file=../../.env.local scripts/replay.mts \
 *     --strategy-type=EMA_CROSSOVER --params='{"quantity":1}' \
 *     --symbols=NSE:NIFTY50-INDEX --index-symbols=NSE:NIFTY50-INDEX \
 *     --from=2026-03-02 --to=2026-03-06 --capital=1000000 [--seed=0] \
 *     [--db=neelkanth_research] [--dns=1.1.1.1] [--exit-rules='{"maxHoldMinutes":60}'] [--dry-run]
 *
 * Reads `candles` and writes one `replay_runs` document in the database
 * MONGO_URI names — the research database, never the trading one. It cannot
 * reach orders, positions, trades or signals (design D3); `--dry-run` keeps
 * nothing at all. The same arguments give the same fingerprint, every time.
 *
 * Runs the BUILT replay code: `pnpm build` first, as for backfill-candles.
 */
import dns from "node:dns";
import { MongoClient } from "mongodb";
import { DEFAULT_GLOBAL_SETTINGS } from "@neelkanth/db";
import type { CandleInterval, StrategyConfig } from "@neelkanth/core";
import { replayFromStore } from "../dist/replay/store.js";

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

const type = required("strategy-type");
const symbols = list("symbols");
if (symbols.length === 0) throw new Error("--symbols=<a,b> is required");
const indexSymbols = list("index-symbols");
const exitRules = args.get("exit-rules");
const strategy: StrategyConfig = {
  strategyId: `replay_${type}`,
  ownerId: "replay",
  type,
  name: `${type} replay`,
  params: JSON.parse(args.get("params") ?? "{}") as Record<string, unknown>,
  symbols,
  ...(exitRules === undefined
    ? {}
    : { exitRules: JSON.parse(exitRules) as StrategyConfig["exitRules"] }),
  enabled: true,
  status: "active",
  createdAt: 0,
  updatedAt: 0,
};

// --dns=1.1.1.1,8.8.8.8 when the local resolver refuses the SRV lookup a
// mongodb+srv:// URI needs; it changes nothing else.
const resolvers = list("dns");
if (resolvers.length > 0) dns.setServers(resolvers);

const uri = process.env["MONGO_URI"];
if (!uri) throw new Error("MONGO_URI is not set");
const client = new MongoClient(uri);
await client.connect();
try {
  // --db names the research database when MONGO_URI points elsewhere.
  const db = client.db(args.get("db"));
  const dryRun = args.get("dry-run") === "true";
  const createdAt = Date.now();
  const { run, saved } = await replayFromStore(db, {
    strategy,
    symbols: [...new Set([...symbols, ...indexSymbols])],
    interval: (args.get("interval") ?? "5m") as CandleInterval,
    fromDate: required("from"),
    toDate: required("to"),
    hours: DEFAULT_GLOBAL_SETTINGS.marketHours,
    allocatedCapital: Number(required("capital")),
    limits: DEFAULT_GLOBAL_SETTINGS.globalRiskLimits,
    seed: Number(args.get("seed") ?? "0"),
    runId: `run_${String(createdAt)}`,
    createdAt,
    save: !dryRun,
  });

  const { manifest, record } = run;
  const byReason = new Map<string, number>();
  for (const t of record.trades)
    byReason.set(
      t.exitReason ?? "(none)",
      (byReason.get(t.exitReason ?? "(none)") ?? 0) + 1,
    );
  console.log(`database     ${db.databaseName}`);
  console.log(
    `strategy     ${manifest.strategy.type} ${manifest.strategy.strategyVersion}`,
  );
  console.log(
    `dataset      ${manifest.dataset.symbols.join(", ")} ${manifest.dataset.interval}`,
  );
  console.log(
    `days         ${String(manifest.dataset.days.length)} (${manifest.dataset.days[0] ?? "-"} .. ${manifest.dataset.days.at(-1) ?? "-"}), ${String(manifest.dataset.bars)} bars, ${JSON.stringify(manifest.dataset.sources)}`,
  );
  if (manifest.synthetic.length > 0)
    console.log(
      `synthetic    ${manifest.synthetic.join(", ")} — P&L in index points, not a tradable contract`,
    );
  console.log(
    `trades       ${String(record.trades.length)} ${JSON.stringify(Object.fromEntries(byReason))}`,
  );
  console.log(
    `realized     ${String(record.realizedPnl)}  (open at end: ${String(record.openAtEnd)})`,
  );
  console.log(`fingerprint  ${run.fingerprint}`);
  console.log(
    dryRun
      ? "kept         nothing (dry run)"
      : `kept         ${saved ? "replay_runs" : "NOT kept — run id taken"}`,
  );
} finally {
  await client.close();
}
