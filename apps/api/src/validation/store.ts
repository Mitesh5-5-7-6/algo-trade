import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { canonicalJson, type CandleInterval } from "@neelkanth/core";
import { StrategyExperimentsRepository } from "@neelkanth/db";
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
