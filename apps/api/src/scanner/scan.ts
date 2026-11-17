import { createHash } from "node:crypto";
import {
  canonicalJson,
  istDateKey,
  istDayStart,
  isTradingDayIST,
  type Candle,
} from "@neelkanth/core";
import { sweepPatterns } from "@neelkanth/engines";
import {
  createPatternRegistry,
  type PatternRegistry,
  type RunnableDetector,
} from "@neelkanth/patterns";
import type { UniverseMember, UniverseRejection } from "./universe.js";

/** Bumped whenever the same bars and universe would give a different scan. */
export const SCAN_VERSION = "1";

const DAY_MS = 86_400_000;

/**
 * One condition a scan looks for: a Phase 5 detector at fixed parameters
 * (design §7.1 D4 — no new indicator mathematics).
 */
export interface ScanCondition {
  patternId: string;
  params?: Record<string, unknown>;
}

/**
 * The daily conditions: the three detectors whose structure means something
 * across days. `ORB_BREAKOUT` and `VWAP_RECLAIM` are left out — both are
 * anchored to an intraday session, and a daily bar has no opening range and
 * no session VWAP to reclaim.
 */
export const DAILY_CONDITIONS: readonly ScanCondition[] = [
  { patternId: "EMA_CROSS" },
  { patternId: "HIGH_VOLUME_BREAKOUT" },
  { patternId: "RSI_REVERSION" },
];

/**
 * Why a scan is PARTIAL whatever the bars say (D6, D7): the ban list has no
 * verified source yet (15.12), so a candidate may be a banned security.
 */
export const BAN_LIST_NOT_CHECKED =
  "the F&O ban list was not checked (design §7.1 D7): a candidate may be in the ban period";

export interface ScanRequest {
  /** The trading day the scan is for, "YYYY-MM-DD" IST. It runs before the open. */
  scanDate: string;
  /** From `buildUniverse`. */
  members: readonly UniverseMember[];
  /** The universe's own rejections, carried into the scan's record (D3). */
  universeRejected?: readonly UniverseRejection[];
  /**
   * Stored daily bars by symbol, oldest first, every one strictly before
   * `scanDate`. A bar on or after it is refused: it is the scan day's own
   * result, which a pre-open scan cannot have seen.
   */
  barsBySymbol: ReadonlyMap<string, readonly Candle[]>;
  holidays?: ReadonlySet<string>;
  specialSessions?: ReadonlySet<string>;
  /** Defaults to `DAILY_CONDITIONS`. */
  conditions?: readonly ScanCondition[];
  /** Defaults to the built-in detectors. */
  registry?: PatternRegistry;
}

/** A condition that held on the data day's bar. */
export interface HeldCondition {
  patternId: string;
  detectorVersion: string;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  evidence: Record<string, number>;
}

/** What one condition said about one instrument on the data day. */
export type ConditionVerdict =
  "HELD" | "NOT_HELD" | "WARMING_UP" | "VOLUME_NOT_TRUSTED";

export interface ScanCandidate {
  underlying: string;
  kind: UniverseMember["kind"];
  symbol: string;
  future: string;
  lotSize: number;
  /** Bucket time of the bar the conditions were judged on, epoch ms. */
  dataTime: number;
  close: number;
  /** BULLISH, BEARISH, or MIXED when held conditions disagree. */
  bias: "BULLISH" | "BEARISH" | "MIXED";
  held: HeldCondition[];
  verdicts: Record<string, ConditionVerdict>;
}

export interface ScanRejection {
  underlying: string;
  symbol: string;
  /**
   * `NO_BARS` — nothing stored for it. `STALE_DATA` — its latest bar is not
   * the data day's. `NOT_JUDGEABLE` — no condition could judge it (warming
   * up, or volume not trusted). `NO_CONDITION` — judged, and none held.
   */
  reason: "NO_BARS" | "STALE_DATA" | "NOT_JUDGEABLE" | "NO_CONDITION";
  detail: string;
  /** Bucket time of the newest bar it had, or null when it had none. */
  dataTime: number | null;
  verdicts: Record<string, ConditionVerdict>;
}

export interface ScanResult {
  scanVersion: string;
  scanDate: string;
  /** The last trading day before `scanDate`: the bar every condition is judged on. */
  dataDate: string;
  /** PARTIAL until the ban list is verified (D7), and whenever data was missing. */
  status: "PARTIAL" | "COMPLETE";
  partialBecause: string[];
  conditions: {
    patternId: string;
    detectorVersion: string;
    definition: string;
    params: Record<string, unknown>;
  }[];
  /** A to Z by underlying. */
  candidates: ScanCandidate[];
  /** A to Z by underlying: every member not selected, with its reason. */
  rejected: ScanRejection[];
  universeRejected: UniverseRejection[];
  counts: {
    members: number;
    candidates: number;
    rejected: Record<ScanRejection["reason"], number>;
    universeRejected: number;
  };
}

/** The scan and its fingerprint: sha256 of the canonical result. */
export interface ScanRun {
  result: ScanResult;
  fingerprint: string;
}

/**
 * The pre-open scan (design §7.1 D8, task 18.3): judge every member of the
 * universe on its last daily bar before the scan day, with the Phase 5
 * detectors.
 *
 * **Candidates, never signals (D2).** A candidate is an instrument on which a
 * structure completed yesterday; it carries no entry, stop or size, and
 * nothing here can reach an order.
 *
 * **Every member decided and explained (D3)** — a candidate with the
 * conditions that held, or a rejection with its reason — each with the time
 * of the bar it was judged on.
 *
 * Pure and synchronous: the same request gives the same result, byte for
 * byte, which is what the fingerprint records.
 */
export function runScan(request: ScanRequest): ScanRun {
  const holidays = request.holidays ?? new Set<string>();
  const specialSessions = request.specialSessions ?? new Set<string>();
  if (!isTradingDayIST(request.scanDate, holidays, specialSessions))
    throw new Error(
      `${request.scanDate} is not a trading day: a pre-open scan is for a day the exchange opens`,
    );
  const dataDate = previousTradingDay(
    request.scanDate,
    holidays,
    specialSessions,
  );

  const registry = request.registry ?? createPatternRegistry();
  const detectors = (request.conditions ?? DAILY_CONDITIONS).map((c) =>
    registry.instantiate(c.patternId, c.params ?? {}),
  );

  const candidates: ScanCandidate[] = [];
  const rejected: ScanRejection[] = [];
  const scanDayStart = istDayStart(request.scanDate);

  for (const member of [...request.members].sort((a, b) =>
    a.underlying.localeCompare(b.underlying),
  )) {
    const bars = request.barsBySymbol.get(member.symbol) ?? [];
    for (const bar of bars) {
      if (bar.ts >= scanDayStart)
        throw new Error(
          `scan for ${request.scanDate} was given a ${member.symbol} bar of ${istDateKey(bar.ts)}: a pre-open scan cannot see its own day or later`,
        );
      if (bar.interval !== "1d")
        throw new Error(
          `scan was given a ${bar.interval} bar for ${member.symbol}: it judges daily bars only`,
        );
    }

    const last = bars.at(-1);
    if (last === undefined) {
      rejected.push({
        underlying: member.underlying,
        symbol: member.symbol,
        reason: "NO_BARS",
        detail: `no daily bars stored for ${member.symbol}`,
        dataTime: null,
        verdicts: {},
      });
      continue;
    }
    const lastDate = istDateKey(last.ts);
    if (lastDate !== dataDate) {
      rejected.push({
        underlying: member.underlying,
        symbol: member.symbol,
        reason: "STALE_DATA",
        detail: `its latest daily bar is ${lastDate}, not ${dataDate}`,
        dataTime: last.ts,
        verdicts: {},
      });
      continue;
    }

    const { verdicts, held } = judgeLastBar(member.symbol, bars, detectors);
    if (held.length > 0) {
      const directions = new Set(held.map((h) => h.direction));
      candidates.push({
        underlying: member.underlying,
        kind: member.kind,
        symbol: member.symbol,
        future: member.future,
        lotSize: member.lotSize,
        dataTime: last.ts,
        close: last.close,
        bias:
          directions.size === 1 && directions.has("BULLISH")
            ? "BULLISH"
            : directions.size === 1 && directions.has("BEARISH")
              ? "BEARISH"
              : "MIXED",
        held,
        verdicts,
      });
      continue;
    }
    const judged = Object.values(verdicts).some((v) => v === "NOT_HELD");
    rejected.push({
      underlying: member.underlying,
      symbol: member.symbol,
      reason: judged ? "NO_CONDITION" : "NOT_JUDGEABLE",
      detail: Object.entries(verdicts)
        .map(([id, v]) => `${id} ${describe(v)}`)
        .join("; "),
      dataTime: last.ts,
      verdicts,
    });
  }

  const count = (reason: ScanRejection["reason"]): number =>
    rejected.filter((r) => r.reason === reason).length;
  const counts: ScanResult["counts"] = {
    members: request.members.length,
    candidates: candidates.length,
    rejected: {
      NO_BARS: count("NO_BARS"),
      STALE_DATA: count("STALE_DATA"),
      NOT_JUDGEABLE: count("NOT_JUDGEABLE"),
      NO_CONDITION: count("NO_CONDITION"),
    },
    universeRejected: request.universeRejected?.length ?? 0,
  };

  const partialBecause = [BAN_LIST_NOT_CHECKED];
  const missing = counts.rejected.NO_BARS + counts.rejected.STALE_DATA;
  if (missing > 0)
    partialBecause.push(
      `${String(missing)} of ${String(counts.members)} member(s) had no daily bar for ${dataDate}`,
    );
  if (counts.rejected.NOT_JUDGEABLE > 0)
    partialBecause.push(
      `${String(counts.rejected.NOT_JUDGEABLE)} member(s) could not be judged by any condition`,
    );

  const result: ScanResult = {
    scanVersion: SCAN_VERSION,
    scanDate: request.scanDate,
    dataDate,
    status: "PARTIAL",
    partialBecause,
    conditions: detectors.map((d) => ({
      patternId: d.patternId,
      detectorVersion: d.detectorVersion,
      definition: d.definition,
      params: d.params,
    })),
    candidates,
    rejected,
    universeRejected: [...(request.universeRejected ?? [])],
    counts,
  };
  return { result, fingerprint: scanFingerprint(result) };
}

/** sha256 over the canonical serialisation — key order cannot move it. */
export function scanFingerprint(result: ScanResult): string {
  return createHash("sha256").update(canonicalJson(result)).digest("hex");
}

/** The last trading day strictly before `dateKey`. */
export function previousTradingDay(
  dateKey: string,
  holidays: ReadonlySet<string>,
  specialSessions: ReadonlySet<string>,
): string {
  let day = istDayStart(dateKey) - DAY_MS;
  // Two weeks back is past any NSE closure on record; a calendar that finds
  // nothing in it is misconfigured, and guessing would hide that.
  for (let i = 0; i < 14; i += 1, day -= DAY_MS) {
    const key = istDateKey(day);
    if (isTradingDayIST(key, holidays, specialSessions)) return key;
  }
  throw new Error(`no trading day in the two weeks before ${dateKey}`);
}

/**
 * What each condition said on the series' last bar.
 *
 * The sweep reports counts, not per-bar outcomes, so the last bar's fate is
 * read as the difference between a sweep of every bar and one of all but the
 * last: whatever the second did not count, the last bar caused. That keeps the
 * warm-up and volume rules the sweep's own (Phase 5 D3) rather than a copy.
 */
function judgeLastBar(
  symbol: string,
  bars: readonly Candle[],
  detectors: readonly RunnableDetector[],
): { verdicts: Record<string, ConditionVerdict>; held: HeldCondition[] } {
  const sweep = (candles: readonly Candle[]) =>
    sweepPatterns({ symbol, interval: "1d", candles, detectors });
  const all = sweep(bars);
  const before = sweep(bars.slice(0, -1));
  const lastTs = bars.at(-1)?.ts;

  const verdicts: Record<string, ConditionVerdict> = {};
  const held: HeldCondition[] = [];
  for (const detector of detectors) {
    const id = detector.patternId;
    const occurrence = all.occurrences.find(
      (o) => o.patternId === id && o.ts === lastTs,
    );
    if (occurrence !== undefined) {
      verdicts[id] = "HELD";
      held.push({
        patternId: id,
        detectorVersion: occurrence.detectorVersion,
        direction: occurrence.direction,
        evidence: occurrence.evidence,
      });
    } else if (
      (all.skippedForWarmup[id] ?? 0) > (before.skippedForWarmup[id] ?? 0)
    ) {
      verdicts[id] = "WARMING_UP";
    } else if (
      (all.declinedForVolume[id] ?? 0) > (before.declinedForVolume[id] ?? 0)
    ) {
      verdicts[id] = "VOLUME_NOT_TRUSTED";
    } else {
      verdicts[id] = "NOT_HELD";
    }
  }
  return { verdicts, held };
}

function describe(verdict: ConditionVerdict): string {
  switch (verdict) {
    case "HELD":
      return "held";
    case "NOT_HELD":
      return "did not hold";
    case "WARMING_UP":
      return "could not judge: not enough bars yet";
    case "VOLUME_NOT_TRUSTED":
      return "could not judge: volume not trusted";
  }
}
