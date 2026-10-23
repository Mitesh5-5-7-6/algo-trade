/**
 * Candidates, backtests, walk-forward and the validation gate (Phase 13).
 *
 *   node --env-file=../../.env.local scripts/validation.mts <command> [options]
 *
 *   declare --hypothesis=H-0003 --strategy=RSI --grid='[{},{"period":21}]' \
 *           --symbols=NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX --statement="…"
 *                       declare a candidate — the operator's act; from a
 *                       registered hypothesis; never edited
 *   list                every candidate, and its latest verdict
 *   backtest --strategy=ORB [--params='{"rangeMinutes":30}'] --symbols=… \
 *            --from=2026-01-01 --to=2026-03-31 --capital=1000000 [--stressed] [--save]
 *                       one parameter set over one window
 *   walk-forward --candidate=SC-0001 --capital=1000000 [--dry-run]
 *                       three months' training, a month's test, rolling; kept
 *   verdict --candidate=SC-0001 [--walk-forward=wf_…]
 *                       the standard gate on a walk-forward (the latest by default)
 *
 *   [--regime-index=NSE:NIFTY50-INDEX] [--db=neelkanth_research] [--dns=1.1.1.1]
 *
 * Reads candles, hypotheses and candidates; writes strategy_candidates,
 * backtests and walk_forward_results only — in the research database or a
 * scratch one. Nothing here enables, changes or promotes a strategy: PASS
 * makes a candidate eligible for paper validation (Phase 14), no more.
 *
 * Runs the BUILT code: `pnpm build` first.
 */
import dns from "node:dns";
import { MongoClient } from "mongodb";
import {
  DEFAULT_GLOBAL_SETTINGS,
  StrategyCandidatesRepository,
  WalkForwardResultsRepository,
} from "@neelkanth/db";
import { DEFAULT_REGIME_MODEL } from "../dist/counterfactual/regime.js";
import { declareCandidate } from "../dist/backtest/candidates.js";
import { backtestFromStore } from "../dist/backtest/store.js";
import { walkForwardFromStore } from "../dist/backtest/walk-forward-store.js";
import { judge } from "../dist/backtest/gate.js";
import type { BacktestMetrics } from "../dist/backtest/metrics.js";
import type { WalkForwardResult } from "../dist/backtest/walk-forward.js";

const [command] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
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
const COMMANDS = ["declare", "list", "backtest", "walk-forward", "verdict"];
if (!COMMANDS.includes(command ?? ""))
  throw new Error(`usage: validation.mts ${COMMANDS.join(" | ")} …`);

const WRITABLE = /^(neelkanth_research|neelkanth_(it|ci)_.+)$/;
const resolvers = list("dns");
if (resolvers.length > 0) dns.setServers(resolvers);
const uri = process.env["MONGO_URI"];
if (!uri) throw new Error("MONGO_URI is not set");
const client = new MongoClient(uri);
await client.connect();

const regime = {
  ...DEFAULT_REGIME_MODEL,
  symbol: args.get("regime-index") ?? DEFAULT_REGIME_MODEL.symbol,
};
const settings = () => ({
  interval: "5m" as const,
  hours: DEFAULT_GLOBAL_SETTINGS.marketHours,
  allocatedCapital: Number(required("capital")),
  limits: DEFAULT_GLOBAL_SETTINGS.globalRiskLimits,
  seed: Number(args.get("seed") ?? "0"),
  regime,
});
const n = (x: number | null, p = 2) => (x === null ? "—" : x.toFixed(p));
const pct = (x: number | null) =>
  x === null ? "—" : `${(x * 100).toFixed(1)}%`;
const line = (label: string, m: BacktestMetrics) =>
  `${label.padEnd(10)} n = ${String(m.trades).padStart(4)}  net ${n(m.net).padStart(11)}  per Trade ${n(m.expectancy).padStart(8)}  p ${n(m.expectancyPValue, 4)}  win ${pct(m.winRate)}  PF ${n(m.profitFactor)}  DD ${pct(m.maxDrawdownPct)}  Sharpe ${n(m.sharpe)}  months+ ${pct(m.profitableMonths)}`;
const showVerdict = (wf: WalkForwardResult) => {
  const v = judge(wf);
  console.log(
    `\nverdict      ${v.verdict} (gate ${v.gateVersion})${v.failed.length > 0 ? ` — failed: ${v.failed.join(", ")}` : ""}`,
  );
  for (const c of v.criteria)
    console.log(
      `  ${c.held ? "✓" : "✗"} ${c.name.padEnd(20)} ${c.threshold.padEnd(48)} ${c.value}`,
    );
};

try {
  const db = client.db(args.get("db"));
  if (
    command !== "list" &&
    command !== "verdict" &&
    !WRITABLE.test(db.databaseName)
  )
    throw new Error(
      `refusing to write to "${db.databaseName}": only neelkanth_research or a scratch neelkanth_it_*/neelkanth_ci_* database`,
    );

  if (command === "declare") {
    const c = await declareCandidate(
      db,
      {
        strategyType: required("strategy"),
        grid: JSON.parse(args.get("grid") ?? "[{}]") as Record<
          string,
          unknown
        >[],
        symbols: list("symbols"),
        hypothesisId: required("hypothesis"),
        statement: required("statement"),
      },
      Date.now(),
    );
    console.log(
      `declared     ${c.candidateId}: ${c.strategyType} × ${String(c.grid.length)} variants on ${c.symbols.join(", ")}, from ${c.hypothesisId}`,
    );
    c.grid.forEach((g, i) =>
      console.log(`  variant ${String(i + 1)}  ${JSON.stringify(g)}`),
    );
  } else if (command === "list") {
    const wfs = new WalkForwardResultsRepository(db);
    for (const c of await new StrategyCandidatesRepository(db).list()) {
      const latest = (await wfs.forCandidate(c.candidateId)).at(-1);
      const verdict =
        latest === undefined
          ? "not walked forward"
          : judge(latest.result as unknown as WalkForwardResult).verdict;
      console.log(
        `${c.candidateId}  ${c.strategyType.padEnd(14)} ${String(c.grid.length).padStart(2)} variants  ${c.hypothesisId}  ${verdict}  ${c.statement}`,
      );
    }
  } else if (command === "backtest") {
    const save = args.get("save") === "true";
    const { backtest, saved } = await backtestFromStore(
      db,
      {
        strategyType: required("strategy"),
        params: JSON.parse(args.get("params") ?? "{}") as Record<
          string,
          unknown
        >,
        symbols: list("symbols"),
        fromDate: required("from"),
        toDate: required("to"),
        stressed: args.get("stressed") === "true",
        ...settings(),
      },
      save
        ? {
            save: true,
            backtestId: `bt_${String(Date.now())}`,
            createdAt: Date.now(),
            context: { by: "operator" },
          }
        : { save: false },
    );
    console.log(
      `${backtest.strategyType} ${JSON.stringify(backtest.params)} ${backtest.window.fromDate} .. ${backtest.window.toDate}, ${backtest.symbols.join(", ")}, ${backtest.costs.stressed ? "stressed costs" : "normal costs"}, strategy ${backtest.strategyVersion}`,
    );
    console.log(line("result", backtest.metrics));
    console.log(`by regime    ${JSON.stringify(backtest.metrics.byRegime)}`);
    console.log(`kept         ${saved ? "yes" : "no"}`);
  } else if (command === "walk-forward") {
    const dry = args.get("dry-run") === "true";
    const walkForwardId = `wf_${required("candidate")}_${String(Date.now())}`;
    const startedAt = Date.now();
    const { result, saved } = await walkForwardFromStore(
      db,
      required("candidate"),
      settings(),
      dry
        ? { save: false }
        : { save: true, walkForwardId, createdAt: Date.now() },
    );
    for (const f of result.folds) {
      const train = f.training
        .map(
          (t) =>
            `v${String(t.variant)} n=${String(t.trades)} ${n(t.expectancy)}`,
        )
        .join(" | ");
      console.log(
        `fold ${f.test.fromDate.slice(0, 7)}  train ${f.train.fromDate.slice(0, 7)}..${f.train.toDate.slice(0, 7)} [${train}]  chosen ${f.chosen === null ? "none" : `v${String(f.chosen)}`}`,
      );
    }
    console.log("");
    console.log(line("candidate", result.outOfSample.normal));
    console.log(line("stressed", result.outOfSample.stressed));
    console.log(line("baseline", result.outOfSample.baseline));
    console.log(`choices      ${JSON.stringify(result.choices)}`);
    showVerdict(result);
    console.log(
      `\nkept         ${saved ? walkForwardId : dry ? "no (dry run)" : "no"}; ${String(Date.now() - startedAt)} ms`,
    );
  } else {
    const candidateId = required("candidate");
    const wfs = await new WalkForwardResultsRepository(db).forCandidate(
      candidateId,
    );
    const doc = args.has("walk-forward")
      ? wfs.find((w) => w.walkForwardId === args.get("walk-forward"))
      : wfs.at(-1);
    if (doc === undefined) throw new Error(`no walk-forward of ${candidateId}`);
    const wf = doc.result as unknown as WalkForwardResult;
    console.log(
      `${candidateId} — ${doc.walkForwardId}, ${String(wf.folds.length)} folds`,
    );
    console.log(line("candidate", wf.outOfSample.normal));
    showVerdict(wf);
  }
} finally {
  await client.close();
}
