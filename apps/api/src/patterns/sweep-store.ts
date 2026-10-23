import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import {
  canonicalJson,
  istDayStart,
  type CandleInterval,
  type PatternOccurrence,
} from "@neelkanth/core";
import {
  CandlesRepository,
  PatternCatalogRepository,
  PatternObservationsRepository,
  type CatalogOutcome,
} from "@neelkanth/db";
import { PatternSweepRunner } from "@neelkanth/engines";
import { createPatternRegistry } from "@neelkanth/patterns";

const DAY_MS = 86_400_000;

/** A sweep of the stored research dataset (Phase 5 task 5.6). */
export interface StoredSweepRequest {
  symbols: string[];
  interval: CandleInterval;
  /** IST trading dates, inclusive at both ends. */
  fromDate: string;
  toDate: string;
  /**
   * Which detectors, at which parameters: `patternId → params`. Absent means
   * every built-in detector at its defaults.
   */
  detectors?: Record<string, unknown>;
  /** Stamped on new observations. Never part of any result compared. */
  observedAt: number;
  /** False for a dry run: sweep and report, keep nothing. */
  save: boolean;
}

export interface SymbolSweep {
  symbol: string;
  bars: number;
  sessions: number;
  firstSession: string | null;
  lastSession: string | null;
  /** Occurrences per pattern. */
  found: Record<string, number>;
  skippedForWarmup: Record<string, number>;
  declinedForVolume: Record<string, number>;
  /** Rows the store did not already have; 0 on a dry run. */
  recorded: number;
  /** sha256 of the occurrences — what makes two sweeps comparable (5.7). */
  fingerprint: string;
  occurrences: PatternOccurrence[];
}

export interface StoredSweepReport {
  /** The catalogue as it stood — written by a real run, only read by a dry run. */
  catalog: CatalogOutcome;
  symbols: SymbolSweep[];
  /** sha256 over every symbol's occurrences, in request order. */
  fingerprint: string;
}

/** A detector version now means something other than what it catalogued. */
export class CatalogConflictError extends Error {
  constructor(readonly outcome: CatalogOutcome) {
    super(
      `refusing to sweep: ${outcome.conflicts
        .map((c) => `${c.patternId}@${c.detectorVersion}`)
        .join(", ")} changed without a version bump (Phase 5 D5)`,
    );
    this.name = "CatalogConflictError";
  }
}

/**
 * Sweep the research database's stored bars and keep what was found (D6).
 *
 * It touches exactly three collections: it READS `candles`, and WRITES
 * `patterns` and `pattern_observations`. Nothing here can reach orders,
 * positions, trades or signals.
 *
 * The catalogue goes first. A detector whose version is already catalogued
 * with a different rule refuses the whole sweep before any observation is
 * written: recording under it would label new evidence with an old meaning.
 */
export async function sweepFromStore(
  db: Db,
  request: StoredSweepRequest,
): Promise<StoredSweepReport> {
  const registry = createPatternRegistry();
  const chosen =
    request.detectors ??
    Object.fromEntries(registry.ids().map((id) => [id, {}]));
  const detectors = Object.entries(chosen).map(([id, params]) =>
    registry.instantiate(id, params),
  );
  const definitions = registry
    .catalog()
    .filter((d) => Object.hasOwn(chosen, d.patternId));

  const catalogRepo = new PatternCatalogRepository(db);
  const catalog = request.save
    ? await catalogRepo.register(definitions)
    : await catalogRepo.check(definitions);
  if (catalog.conflicts.length > 0) throw new CatalogConflictError(catalog);

  const observations = new PatternObservationsRepository(db);
  const runner = new PatternSweepRunner({
    candles: new CandlesRepository(db),
    observations: request.save
      ? observations
      : { recordMany: () => Promise.resolve(0) },
    detectors,
    now: () => request.observedAt,
    onError: () => {
      // Rethrown by the runner; the caller reports it.
    },
  });

  const fromTs = istDayStart(request.fromDate);
  const toTs = istDayStart(request.toDate) + DAY_MS; // half-open, toDate inclusive
  const symbols: SymbolSweep[] = [];
  for (const symbol of request.symbols) {
    const run = await runner.run(symbol, request.interval, fromTs, toTs);
    const found: Record<string, number> = {};
    for (const o of run.occurrences)
      found[o.patternId] = (found[o.patternId] ?? 0) + 1;
    symbols.push({
      symbol,
      bars: run.barsScanned,
      sessions: run.sessions.length,
      firstSession: run.sessions[0] ?? null,
      lastSession: run.sessions.at(-1) ?? null,
      found,
      skippedForWarmup: run.skippedForWarmup,
      declinedForVolume: run.declinedForVolume,
      recorded: run.recorded,
      fingerprint: digest(run.occurrences),
      occurrences: run.occurrences,
    });
  }
  return {
    catalog,
    symbols,
    fingerprint: digest(symbols.map((s) => s.occurrences)),
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
