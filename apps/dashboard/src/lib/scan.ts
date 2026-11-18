/**
 * The pre-open F&O scan as the research service returns it (design §7.1 D8),
 * and the little the page does with it: check the request, say each
 * condition in words. Every number is the service's.
 */

export interface ScanRequest {
  date: string;
  minDaysToExpiry: number;
  save?: boolean;
}

export type ConditionVerdict =
  "HELD" | "NOT_HELD" | "WARMING_UP" | "VOLUME_NOT_TRUSTED";

export interface HeldCondition {
  patternId: string;
  detectorVersion: string;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  evidence: Record<string, number>;
}

export interface ScanCandidate {
  underlying: string;
  kind: "INDEX" | "STOCK";
  symbol: string;
  future: string;
  lotSize: number;
  dataTime: number;
  close: number;
  bias: "BULLISH" | "BEARISH" | "MIXED";
  held: HeldCondition[];
  verdicts: Record<string, ConditionVerdict>;
}

export type RejectionReason =
  "NO_BARS" | "STALE_DATA" | "NOT_JUDGEABLE" | "NO_CONDITION";

export interface ScanRejection {
  underlying: string;
  symbol: string;
  reason: RejectionReason;
  detail: string;
  dataTime: number | null;
  verdicts: Record<string, ConditionVerdict>;
}

export interface ScanResponse {
  experimentId: string | null;
  saved: boolean;
  fingerprint: string;
  manifest: { minDaysToExpiry: number; universeAsOf: number };
  result: {
    scanDate: string;
    dataDate: string;
    status: "PARTIAL" | "COMPLETE";
    partialBecause: string[];
    conditions: {
      patternId: string;
      detectorVersion: string;
      definition: string;
      params: Record<string, unknown>;
    }[];
    candidates: ScanCandidate[];
    rejected: ScanRejection[];
    universeRejected: { underlying: string; reason: string; detail: string }[];
    counts: {
      members: number;
      candidates: number;
      rejected: Record<RejectionReason, number>;
      universeRejected: number;
    };
  };
}

export interface ScanCoverage {
  symbol: string;
  bars: number;
  firstDate: string;
  lastDate: string;
}

export type ParsedScan =
  { ok: true; request: ScanRequest } | { ok: false; error: string };

/** Check the form before it is sent; the service checks it again. */
export function parseScanForm(form: {
  date: string;
  minDaysToExpiry: string;
}): ParsedScan {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date))
    return { ok: false, error: "Choose the trading day the scan is for." };
  const minDays = Number(form.minDaysToExpiry);
  if (
    form.minDaysToExpiry.trim() === "" ||
    !Number.isInteger(minDays) ||
    minDays < 0 ||
    minDays > 30
  )
    return {
      ok: false,
      error: "Minimum days to expiry is a whole number from 0 to 30.",
    };
  return { ok: true, request: { date: form.date, minDaysToExpiry: minDays } };
}

const CONDITION_WORDS: Record<string, string> = {
  EMA_CROSS: "EMA cross",
  HIGH_VOLUME_BREAKOUT: "Volume breakout",
  RSI_REVERSION: "RSI reversion",
};

/** A held condition in a few words, with the evidence that matters most. */
export function describeHeld(held: HeldCondition): string {
  const name = CONDITION_WORDS[held.patternId] ?? held.patternId;
  const direction = held.direction.toLowerCase();
  const e = held.evidence;
  switch (held.patternId) {
    case "EMA_CROSS":
      return `${name}, ${direction}: fast ${fixed(e["fast"])} vs slow ${fixed(e["slow"])}`;
    case "HIGH_VOLUME_BREAKOUT":
      return `${name}, ${direction}: close ${fixed(e["close"])} past ${fixed(
        held.direction === "BEARISH" ? e["priorLow"] : e["priorHigh"],
      )}, volume ${ratio(e["volume"], e["averageVolume"])} of average`;
    case "RSI_REVERSION":
      return `${name}, ${direction}: RSI ${fixed(e["prev"])} → ${fixed(e["rsi"])}`;
    default:
      return `${name}, ${direction}`;
  }
}

/** A rejection's reason in the operator's words. */
export function describeReason(reason: RejectionReason): string {
  switch (reason) {
    case "NO_CONDITION":
      return "No condition held";
    case "NOT_JUDGEABLE":
      return "Could not be judged";
    case "STALE_DATA":
      return "Data not current";
    case "NO_BARS":
      return "No daily bars";
  }
}

/** The IST date of a bar's timestamp. */
export function barDate(ts: number | null): string {
  return ts === null
    ? "—"
    : new Date(ts + 19_800_000).toISOString().slice(0, 10);
}

function fixed(value: number | undefined): string {
  if (value === undefined) return "—";
  return Math.abs(value) >= 1000 ? value.toFixed(0) : value.toFixed(2);
}

function ratio(top: number | undefined, bottom: number | undefined): string {
  if (top === undefined || bottom === undefined || bottom === 0) return "—";
  return `${(top / bottom).toFixed(1)}×`;
}
