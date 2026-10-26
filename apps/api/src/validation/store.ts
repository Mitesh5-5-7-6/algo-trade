import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import {
  canonicalJson,
  istDateKey,
  type CandleInterval,
} from "@neelkanth/core";
import {
  CandlesRepository,
  StrategyExperimentsRepository,
} from "@neelkanth/db";
import type { AttributionModel } from "../counterfactual/attribution.js";
import type { RegimeModel } from "../counterfactual/regime.js";
import type { CounterfactualRun } from "../counterfactual/run.js";
import { counterfactualFromStore } from "../counterfactual/store.js";
import { familyFindings, type Finding } from "./family.js";
import { testHypothesis, type HypothesisTest } from "./gate.js";
import {
  hypothesisFingerprint,
  HypothesisSchema,
  nextHypothesisId,
  type Hypothesis,
} from "./hypothesis.js";

/**
 * Whether a window has closed in the stored data (Phase 12 D6): every
 * instrument of the run has a session on or after the window's last day. A
 * window ending on a non-trading day waits for the next session; an
 * instrument with no data at all keeps it open. Conservative by design: a
 * test spent early on missing data could never be taken again.
 */
export function windowClosed(
  toDate: string,
  lastSessions: Readonly<Record<string, string | null>>,
): { closed: boolean; behind: string[] } {
  const behind = Object.entries(lastSessions)
    .filter(([, last]) => last === null || last < toDate)
    .map(([symbol, last]) => `${symbol} (last session ${last ?? "none"})`)
    .sort();
  return { closed: behind.length === 0, behind };
}

/** The last stored session of each instrument a hypothesis's run reads. */
export async function lastSessionsOf(
  db: Db,
  h: Hypothesis,
): Promise<Record<string, string | null>> {
  const candles = new CandlesRepository(db);
  const symbols = [
    ...new Set([...h.run.symbols, ...h.run.indexSymbols]),
  ].sort();
  const out: Record<string, string | null> = {};
  for (const symbol of symbols) {
    const [last] = await candles.loadRecent(
      symbol,
      h.run.interval as CandleInterval,
      1,
    );
    out[symbol] = last === undefined ? null : istDateKey(last.ts);
  }
  return out;
}

/** A test's id: the hypothesis's own — so a second test cannot be inserted. */
const testIdOf = (hypothesisId: string): string => `${hypothesisId}:test`;

/** Every hypothesis registered, oldest first. */
export async function listHypotheses(db: Db): Promise<Hypothesis[]> {
  const docs = await new StrategyExperimentsRepository(db).listByKind(
    "HYPOTHESIS",
  );
  return docs.map((d) => HypothesisSchema.parse(d.manifest));
}

/** The id the next registration will take. */
export async function nextId(db: Db): Promise<string> {
  return nextHypothesisId(
    (await listHypotheses(db)).map((h) => h.hypothesisId),
  );
}

/**
 * Register a hypothesis (Phase 7 D3) — before any test, once. Refused when
 * its id is taken, or when the same claim is already registered under
 * another id: a claim registered twice would earn two tests.
 */
export async function registerHypothesis(
  db: Db,
  raw: Hypothesis,
): Promise<Hypothesis> {
  const h = HypothesisSchema.parse(raw);
  const fingerprint = hypothesisFingerprint(h);
  const repo = new StrategyExperimentsRepository(db);
  const same = (await repo.findByFingerprint(fingerprint)).filter(
    (d) => d.kind === "HYPOTHESIS",
  );
  if (same.length > 0)
    throw new Error(
      `this claim is already registered as ${same.map((d) => d.experimentId).join(", ")}`,
    );
  const saved = await repo.save({
    experimentId: h.hypothesisId,
    kind: "HYPOTHESIS",
    createdAt: h.registeredAt,
    fingerprint,
    manifest: h,
    result: {},
  });
  if (!saved) throw new Error(`${h.hypothesisId} is already registered`);
  return h;
}

/** Runs shared between hypotheses with the same settings and window. */
export type RunCache = Map<string, Promise<CounterfactualRun>>;

function runFor(
  db: Db,
  h: Hypothesis,
  window: Hypothesis["inSample"],
  cache: RunCache,
): Promise<CounterfactualRun> {
  const key = canonicalJson({
    run: h.run,
    window,
    regime: h.pins.regime,
    attribution: h.pins.attribution,
  });
  let run = cache.get(key);
  if (run === undefined) {
    run = counterfactualFromStore(db, {
      symbols: h.run.symbols,
      indexSymbols: h.run.indexSymbols,
      interval: h.run.interval as CandleInterval,
      fromDate: window.fromDate,
      toDate: window.toDate,
      hours: h.run.hours,
      allocatedCapital: h.run.allocatedCapital,
      limits: h.run.limits,
      seed: h.run.seed,
      ...(h.run.strategyParams === undefined
        ? {}
        : { strategyParams: h.run.strategyParams }),
      regime: h.pins.regime as unknown as RegimeModel,
      attribution: h.pins.attribution as unknown as AttributionModel,
      experimentId: "unkept",
      createdAt: 0,
      save: false,
    }).then((r) => r.run);
    cache.set(key, run);
  }
  return run;
}

/**
 * Test a registered hypothesis, once (Phase 7 D4): counterfactual runs of its
 * in-sample and out-of-sample windows, under its pinned run and models, then
 * the gate. The test is kept under the hypothesis's own id, insert-once, so a
 * second test is refused — no re-rolls.
 */
export async function testRegistered(
  db: Db,
  hypothesisId: string,
  testedAt: number,
  cache: RunCache = new Map(),
): Promise<HypothesisTest> {
  const repo = new StrategyExperimentsRepository(db);
  const doc = await repo.findById(hypothesisId);
  if (doc?.kind !== "HYPOTHESIS")
    throw new Error(`${hypothesisId} is not registered`);
  if ((await repo.findById(testIdOf(hypothesisId))) !== null)
    throw new Error(
      `${hypothesisId} has already been tested; a hypothesis is tested once`,
    );
  const h = HypothesisSchema.parse(doc.manifest);
  // D6: the one test waits for the evidence — refused, nothing kept, while
  // the out-of-sample window is still open in the stored data.
  const open = windowClosed(h.outOfSample.toDate, await lastSessionsOf(db, h));
  if (!open.closed)
    throw new Error(
      `${hypothesisId} cannot be tested yet: its out-of-sample window ends ${h.outOfSample.toDate}, and the data stops before it for ${open.behind.join(", ")} — test it once the window has closed; nothing was kept`,
    );
  const test = testHypothesis(
    h,
    await runFor(db, h, h.inSample, cache),
    await runFor(db, h, h.outOfSample, cache),
    testedAt,
  );
  const saved = await repo.save({
    experimentId: testIdOf(hypothesisId),
    kind: "HYPOTHESIS_TEST",
    createdAt: testedAt,
    fingerprint: createHash("sha256").update(canonicalJson(test)).digest("hex"),
    manifest: {
      hypothesisId,
      hypothesisFingerprint: test.hypothesisFingerprint,
    },
    result: test as unknown as Record<string, unknown>,
  });
  if (!saved)
    throw new Error(
      `${hypothesisId} has already been tested; a hypothesis is tested once`,
    );
  return test;
}

/** A family's findings, from what the registry holds (Phase 7 D6). */
export async function familyReport(db: Db, family: string): Promise<Finding[]> {
  const repo = new StrategyExperimentsRepository(db);
  const hypotheses = (await listHypotheses(db)).filter(
    (h) => h.family === family,
  );
  const tests = (await repo.listByKind("HYPOTHESIS_TEST"))
    .map((d) => d.result as unknown as HypothesisTest)
    .filter((t) => t.family === family);
  return familyFindings(hypotheses, tests);
}
