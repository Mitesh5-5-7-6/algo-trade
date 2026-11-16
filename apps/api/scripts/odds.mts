/**
 * Setup odds — the "Time Machine" (Phase 17, task 17.6).
 *
 * For one plan — entry, stop, target, now — how often does the target come
 * before the stop? Answered two ways, never blended: by replaying the rest of
 * the day from past sessions' bars, and by running the plan's rule over those
 * past sessions through the replay.
 *
 *   node --env-file=../../.env.local scripts/odds.mts \
 *     --symbol=NSE:NIFTYBANK-INDEX --side=LONG \
 *     --entry=55400 --stop=55300 --target=55600 \
 *     --date=2026-11-17 --time=10:05 \
 *     [--rule-type=ORB] [--rule-params='{"rangeMinutes":15}'] \
 *     [--index-symbols=NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX] \
 *     [--replays=10000] [--seed=0] [--window=1] [--pool-sessions=60] \
 *     [--capital=1000000] [--db=neelkanth_research] [--dns=1.1.1.1] [--dry-run]
 *
 * Reads `candles` strictly before --date and writes one `strategy_experiments`
 * document, `kind: "SETUP_ODDS"`, in the database MONGO_URI names — the
 * research database, never a trading one (design §6.1 D7); `--dry-run` keeps
 * nothing at all. The same arguments give the same fingerprint, every time.
 *
 * Any other database is refused before anything connects or the odds code
 * loads: `refusing "<name>": …`.
 *
 * Runs the BUILT code: `pnpm build` first, as for replay.
 */
import dns from "node:dns";
import { MongoClient } from "mongodb";
import { DEFAULT_GLOBAL_SETTINGS } from "@neelkanth/db";
import type { CandleInterval } from "@neelkanth/core";

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
function number(name: string, fallback?: string): number {
  const raw = args.get(name) ?? fallback ?? required(name);
  const value = Number(raw);
  if (raw === "true" || !Number.isFinite(value))
    throw new Error(`--${name}=<number> is required; got "${raw}"`);
  return value;
}
const list = (name: string): string[] =>
  (args.get(name) ?? "").split(",").filter(Boolean);

// The research database or a scratch one, nothing else — decided from the
// names alone, before connecting (design §6.1 D7, §8 D3). Naming a database
// does not connect; --db wins over the one MONGO_URI names.
const RESEARCH = /^(neelkanth_research|neelkanth_(it|ci)_.+)$/;
const uri = process.env["MONGO_URI"];
if (!uri) throw new Error("MONGO_URI is not set");
const client = new MongoClient(uri);
const db = client.db(args.get("db"));
if (!RESEARCH.test(db.databaseName))
  throw new Error(
    `refusing "${db.databaseName}": setup odds reads and writes only neelkanth_research or a scratch neelkanth_it_*/neelkanth_ci_* database`,
  );
const { setupOddsFromStore } = await import("../dist/odds/store.js");

const side = required("side");
if (side !== "LONG" && side !== "SHORT")
  throw new Error(`--side is LONG or SHORT; got "${side}"`);
const date = required("date");
if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
  throw new Error(`--date is an IST date, YYYY-MM-DD; got "${date}"`);
const time = required("time");
if (!/^\d{2}:\d{2}$/.test(time))
  throw new Error(`--time is an IST time, HH:MM; got "${time}"`);
const plan = {
  symbol: required("symbol"),
  side,
  entry: number("entry"),
  stop: number("stop"),
  target: number("target"),
  date,
  time,
} as const;
const ruleType = args.get("rule-type");
const ruleParams = args.get("rule-params");
if (ruleType === undefined && ruleParams !== undefined)
  throw new Error("--rule-params needs --rule-type");
const poolSessions = args.get("pool-sessions");
const dryRun = args.get("dry-run") === "true";

// --dns=1.1.1.1,8.8.8.8 when the local resolver refuses the SRV lookup a
// mongodb+srv:// URI needs; it changes nothing else.
const resolvers = list("dns");
if (resolvers.length > 0) dns.setServers(resolvers);

const pct = (share: number | null): string =>
  share === null ? "—" : `${(share * 100).toFixed(1)}%`;
const points = (edge: number | null): string =>
  edge === null ? "—" : `${edge >= 0 ? "+" : ""}${edge.toFixed(1)} points`;
const of = (count: number, total: number): string =>
  `${String(count)} (${pct(total === 0 ? null : count / total)})`;
const line = (label: string, value: string): void => {
  console.log(`${label.padEnd(15)}${value}`);
};

await client.connect();
try {
  const createdAt = Date.now();
  const { run, saved } = await setupOddsFromStore(db, {
    plan,
    indexSymbols: list("index-symbols"),
    interval: (args.get("interval") ?? "5m") as CandleInterval,
    resampling: {
      replays: number("replays", "10000"),
      seed: number("seed", "0"),
      window: number("window", "1"),
    },
    ...(poolSessions === undefined
      ? {}
      : { lookbackSessions: number("pool-sessions") }),
    ...(ruleType === undefined
      ? {}
      : {
          rule: {
            type: ruleType,
            params:
              ruleParams === undefined
                ? {}
                : (JSON.parse(ruleParams) as Record<string, unknown>),
          },
        }),
    hours: DEFAULT_GLOBAL_SETTINGS.marketHours,
    allocatedCapital: number("capital", "1000000"),
    limits: DEFAULT_GLOBAL_SETTINGS.globalRiskLimits,
    experimentId: `odds_${String(createdAt)}`,
    createdAt,
    save: !dryRun,
  });

  const { manifest, result } = run;
  const { pool } = manifest;
  const r = result.resampled;
  const rv = result.resampledVerdict;

  line("database", db.databaseName);
  line(
    "plan",
    `${plan.side} ${plan.symbol} entry ${String(plan.entry)} stop ${String(plan.stop)} target ${String(plan.target)} (${manifest.plan.targetR.toFixed(2)}R), ${plan.date} ${plan.time}, after bar ${String(manifest.plan.entryBar)}`,
  );
  line(
    "basis",
    "the underlying's own bars — not an option's premium; R is gross, in index points, with no charges or slippage",
  );
  line(
    "pool",
    `${String(pool.sessions)} full sessions (${pool.dates[0] ?? "—"} .. ${pool.dates.at(-1) ?? "—"}), ${String(pool.barsPerSession)} bars each, ${JSON.stringify(pool.sources)}`,
  );
  line(
    "left out",
    pool.excluded.length === 0
      ? "none"
      : pool.excluded
          .map((e) => `${e.date} ${e.reason} (${String(e.bars)} bars)`)
          .join(", "),
  );
  line(
    "resampled",
    `${String(r.replays)} replays, seed ${String(r.seed)}, window ±${String(r.window)}: target first ${of(r.targetFirst, r.replays)}, stop first ${of(r.stopFirst, r.replays)}, neither ${of(r.neither, r.replays)}`,
  );
  line(
    "resampled odds",
    `of ${String(rv.decided)} decided: target ${pct(rv.targetShare)} against break-even ${pct(rv.breakEven)} (${points(rv.edgePoints)}) — ${rv.verdict}`,
  );
  line(
    "resampled R",
    `average ${r.averageR.toFixed(3)}R; ${String(r.gapThroughStop)} stops came through a gap, each scored −1R, which understates the real fill`,
  );
  line(
    "close bands",
    `p5 ${r.closeBands.p5.toFixed(2)}, p25 ${r.closeBands.p25.toFixed(2)}, p50 ${r.closeBands.p50.toFixed(2)}, p75 ${r.closeBands.p75.toFixed(2)}, p95 ${r.closeBands.p95.toFixed(2)}`,
  );
  if (result.history === null || result.historyVerdict === null) {
    line("history", "not run — the plan names no rule (--rule-type)");
  } else {
    const h = result.history;
    const hv = result.historyVerdict;
    line(
      "history",
      `${manifest.history?.rule.type ?? ""} ${manifest.history?.rule.strategyVersion ?? ""} over ${String(h.sessions)} sessions: fired ${String(h.fired)} ${plan.side} (other side ${String(h.otherSide)}) — target ${String(h.targetFirst)}, stop ${String(h.stopFirst)}, neither ${String(h.neither)}`,
    );
    line(
      "history odds",
      `of ${String(hv.decided)} decided: target ${pct(hv.targetShare)}${hv.shareInterval === null ? "" : ` (95% interval ${pct(hv.shareInterval.lower)} .. ${pct(hv.shareInterval.upper)})`} against the rule's own break-even ${pct(hv.breakEven)} (${points(hv.edgePoints)})`,
    );
    line(
      "history R",
      hv.averageR === null || hv.rInterval === null
        ? `no trades to average — ${hv.verdict}`
        : `average ${hv.averageR.toFixed(3)}R over all ${String(hv.fired)} times it fired (95% interval ${hv.rInterval.lower.toFixed(3)}R .. ${hv.rInterval.upper.toFixed(3)}R) — ${hv.verdict}`,
    );
  }
  line(
    "limits",
    "each resampled bar is drawn on its own, so a replayed day has no momentum or volatility clustering; expiry days are not separated; replays are not independent observations",
  );
  line("fingerprint", run.fingerprint);
  line(
    "kept",
    dryRun
      ? "nothing (dry run)"
      : saved
        ? `odds_${String(createdAt)} in strategy_experiments`
        : "NOT kept — the id was already taken",
  );
} finally {
  await client.close();
}
