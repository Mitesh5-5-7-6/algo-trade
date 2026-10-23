/**
 * The hypothesis registry and the statistical gate (Phase 7, 7.6).
 *
 *   register — fix a claim before it is tested; its pins are read off an
 *              in-sample counterfactual run:
 *     node --env-file=../../.env.local scripts/hypotheses.mts register \
 *       --family=F-2026H2 --statement="..." \
 *       --pattern=EMA_CROSS --strategy=EMA_CROSSOVER [--symbol=ALL] [--regime=ALL] \
 *       --metric=expectancy --direction=less --threshold=0 [--alpha=0.05] [--min-sample=30] \
 *       --in-sample=2025-09-29:2026-03-27 --out-of-sample=2026-03-30:2026-09-28 \
 *       --symbols=NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX --index-symbols=... --capital=1000000 \
 *       [--seed=0] [--window=0] [--regime-index=NSE:NIFTY50-INDEX]
 *
 *   register-proposals — register the research agent's proposals (Phase 12):
 *     ... scripts/hypotheses.mts register-proposals --answer=ans_… \
 *       --out-of-sample=2026-03-30:2026-09-28 [--pick=1,3] --capital=1000000 \
 *       [--index-symbols=NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX] \
 *       [--seed=0] [--window=0] [--regime-index=NSE:NIFTY50-INDEX]
 *     The answer must be kept, intact and SUPPORTED; the window must start
 *     after the answer's asOf. Its proposals become one family, P-<answer>.
 *     The operator's act — the agent cannot register anything.
 *
 *   test   — test every untested member of a family, once, out of sample:
 *     ... scripts/hypotheses.mts test --family=F-2026H2
 *
 *   report — the family's findings, corrected together:
 *     ... scripts/hypotheses.mts report --family=F-2026H2
 *
 *   [--db=neelkanth_research] [--dns=1.1.1.1]
 *
 * Reads `candles`; register and test write `strategy_experiments` only, and
 * only to the research database or a scratch one (design D8).
 *
 * Runs the BUILT code: `pnpm build` first.
 */
import dns from "node:dns";
import { MongoClient } from "mongodb";
import { DEFAULT_GLOBAL_SETTINGS } from "@neelkanth/db";
import type { CandleInterval } from "@neelkanth/core";
import { counterfactualFromStore } from "../dist/counterfactual/store.js";
import { DEFAULT_REGIME_MODEL } from "../dist/counterfactual/regime.js";
import { DEFAULT_ATTRIBUTION_MODEL } from "../dist/counterfactual/attribution.js";
import { pinsFor } from "../dist/validation/hypothesis.js";
import { describeFinding } from "../dist/validation/family.js";
import {
  familyReport,
  listHypotheses,
  nextId,
  registerHypothesis,
  testRegistered,
  type RunCache,
} from "../dist/validation/store.js";

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
function window(name: string): { fromDate: string; toDate: string } {
  const [fromDate = "", toDate = ""] = required(name).split(":");
  return { fromDate, toDate };
}

const WRITABLE = /^(neelkanth_research|neelkanth_(it|ci)_.+)$/;
if (
  !["register", "register-proposals", "test", "report"].includes(command ?? "")
)
  throw new Error(
    "usage: hypotheses.mts register|register-proposals|test|report --family=… | --answer=…",
  );

const resolvers = list("dns");
if (resolvers.length > 0) dns.setServers(resolvers);
const uri = process.env["MONGO_URI"];
if (!uri) throw new Error("MONGO_URI is not set");
const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(args.get("db"));
  if (command !== "report" && !WRITABLE.test(db.databaseName))
    throw new Error(
      `refusing to write to "${db.databaseName}": only neelkanth_research or a scratch neelkanth_it_*/neelkanth_ci_* database (D8)`,
    );
  if (command === "register-proposals") {
    const { registerProposals, familyOf } =
      await import("../dist/validation/proposals.js");
    const answerId = required("answer");
    const picks = list("pick").map(Number);
    const results = await registerProposals(db, {
      answerId,
      outOfSample: window("out-of-sample"),
      ...(picks.length === 0 ? {} : { pick: picks }),
      run: {
        interval: args.get("interval") ?? "5m",
        hours: DEFAULT_GLOBAL_SETTINGS.marketHours,
        allocatedCapital: Number(required("capital")),
        limits: DEFAULT_GLOBAL_SETTINGS.globalRiskLimits,
        seed: Number(args.get("seed") ?? "0"),
      },
      indexSymbols:
        list("index-symbols").length > 0
          ? list("index-symbols")
          : [args.get("regime-index") ?? DEFAULT_REGIME_MODEL.symbol],
      regime: {
        ...DEFAULT_REGIME_MODEL,
        symbol: args.get("regime-index") ?? DEFAULT_REGIME_MODEL.symbol,
      },
      attribution: {
        ...DEFAULT_ATTRIBUTION_MODEL,
        windowBars: Number(args.get("window") ?? "0"),
      },
      registeredAt: Date.now(),
    });
    for (const r of results)
      console.log(
        "registered" in r
          ? `registered   P${String(r.proposal)} as ${r.registered.hypothesisId}: ${r.registered.statement} (in sample ${r.registered.inSample.fromDate} .. ${r.registered.inSample.toDate}, out of sample ${r.registered.outOfSample.fromDate} .. ${r.registered.outOfSample.toDate})`
          : `refused      P${String(r.proposal)}: ${r.refused}`,
      );
    console.log(
      `family       ${familyOf(answerId)} — test it with: test --family=${familyOf(answerId)}`,
    );
  } else {
    const family = required("family");

    if (command === "register") {
      const cell = {
        patternId: required("pattern"),
        strategyType: required("strategy"),
        symbol: args.get("symbol") ?? "ALL",
        regime: (args.get("regime") ?? "ALL") as "ALL",
      };
      const run = {
        symbols: list("symbols"),
        indexSymbols: list("index-symbols"),
        interval: args.get("interval") ?? "5m",
        hours: DEFAULT_GLOBAL_SETTINGS.marketHours,
        allocatedCapital: Number(required("capital")),
        limits: DEFAULT_GLOBAL_SETTINGS.globalRiskLimits,
        seed: Number(args.get("seed") ?? "0"),
      };
      const inSample = window("in-sample");
      const regime = {
        ...DEFAULT_REGIME_MODEL,
        symbol: args.get("regime-index") ?? DEFAULT_REGIME_MODEL.symbol,
      };
      const attribution = {
        ...DEFAULT_ATTRIBUTION_MODEL,
        windowBars: Number(args.get("window") ?? "0"),
      };
      const { run: formedOn } = await counterfactualFromStore(db, {
        ...run,
        interval: run.interval as CandleInterval,
        fromDate: inSample.fromDate,
        toDate: inSample.toDate,
        regime,
        attribution,
        experimentId: "unkept",
        createdAt: 0,
        save: false,
      });
      const h = await registerHypothesis(db, {
        hypothesisId: await nextId(db),
        family,
        statement: required("statement"),
        cell,
        metric: required("metric") as "expectancy",
        direction: required("direction") as "less",
        threshold: Number(required("threshold")),
        alpha: Number(args.get("alpha") ?? "0.05"),
        minSample: Number(args.get("min-sample") ?? "30"),
        inSample,
        outOfSample: window("out-of-sample"),
        run,
        pins: pinsFor(formedOn.manifest, cell),
        registeredAt: Date.now(),
      });
      console.log(
        `registered   ${h.hypothesisId} in ${h.family}: ${h.statement}`,
      );
    } else if (command === "test") {
      const cache: RunCache = new Map();
      const members = (await listHypotheses(db)).filter(
        (h) => h.family === family,
      );
      const tested = new Set(
        (await familyReport(db, family))
          .filter((f) => f.verdict !== "UNTESTED")
          .map((f) => f.hypothesisId),
      );
      for (const h of members.filter((m) => !tested.has(m.hypothesisId))) {
        const t = await testRegistered(db, h.hypothesisId, Date.now(), cache);
        console.log(
          `tested       ${h.hypothesisId}: n = ${String(t.outOfSample.n)}, p = ${String(t.outOfSample.pValue)}, ${t.outOfSample.verdict} (before the family correction)`,
        );
      }
    }
    console.log("");
    for (const finding of await familyReport(db, family))
      console.log(describeFinding(finding));
  }
} catch (e) {
  // A refusal is the answer, in one line — not a stack trace.
  console.error(`refused: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
