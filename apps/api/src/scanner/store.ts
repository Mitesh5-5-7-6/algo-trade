import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { istDayStart, type Candle } from "@neelkanth/core";
import { StrategyExperimentsRepository } from "@neelkanth/db";
import { loadCandlesBefore } from "../odds/store.js";
import { runScan, type ScanCondition, type ScanRun } from "./scan.js";
import { buildUniverse, SCAN_UNIVERSE_VERSION } from "./universe.js";

/** The broker's public symbol files (the same ones the trading process reads). */
export const SYMBOL_FILE_URLS = {
  fo: "https://public.fyers.in/sym_details/NSE_FO.csv",
  cm: "https://public.fyers.in/sym_details/NSE_CM.csv",
} as const;

/** 09:00 IST: the universe is judged as it stands before the scan day's open. */
const PRE_OPEN_MS = 9 * 3_600_000;

/**
 * How much daily history a scan reads: 180 calendar days, some 120 sessions —
 * six times the longest condition's warm-up (EMA 21, a 20-bar high, RSI 14),
 * so every average has long converged. Bounded (2026-11-19) so a scan's
 * memory does not grow with every day stored; the whole history once took
 * a 512 MB research service past its limit.
 */
export const SCAN_HISTORY_DAYS = 180;

export interface StoredScanRequest {
  scanDate: string;
  /** The two symbol files' text, read at scan time (design §7.1 D9). */
  files: { fo: string; cm: string };
  minDaysToExpiry: number;
  holidays: ReadonlySet<string>;
  specialSessions: ReadonlySet<string>;
  conditions?: readonly ScanCondition[];
  experimentId: string;
  /** When the run was made — recorded on the document, not in the result. */
  createdAt: number;
  /** False for a dry run: compute and report, keep nothing. */
  save: boolean;
}

/** What the scan was made from, kept beside it so a run can be re-made. */
export interface ScanManifest {
  universeVersion: string;
  /** When contracts were judged: 09:00 IST on the scan day. */
  universeAsOf: number;
  minDaysToExpiry: number;
  /** sha256 of each symbol file as read, so a re-run can tell it has the same input. */
  symbolFiles: { foSha256: string; cmSha256: string };
  holidays: string[];
  specialSessions: string[];
  /** Calendar days of daily history the scan read before its day. */
  historyDays: number;
}

/**
 * A pre-open scan over the research database's stored daily bars, and the run
 * kept (design §7.1 D8, task 18.5).
 *
 * It READS `candles` — daily bars, strictly before the scan day, so the scan
 * cannot see the day it is for — and WRITES `strategy_experiments`,
 * `kind: "SCAN"`, only when asked. It never calls the broker: the bars are
 * the backfill's job. Nothing here can reach orders, positions, trades or
 * signals (D2).
 */
export async function scanFromStore(
  db: Db,
  request: StoredScanRequest,
): Promise<{ run: ScanRun; manifest: ScanManifest; saved: boolean }> {
  const universeAsOf = istDayStart(request.scanDate) + PRE_OPEN_MS;
  const universe = buildUniverse(request.files, {
    asOf: universeAsOf,
    minDaysToExpiry: request.minDaysToExpiry,
  });
  const candles = await loadCandlesBefore(
    db,
    universe.members.map((m) => m.symbol),
    "1d",
    request.scanDate,
    istDayStart(request.scanDate) - SCAN_HISTORY_DAYS * 86_400_000,
  );
  const barsBySymbol = new Map<string, Candle[]>();
  for (const candle of candles) {
    const bars = barsBySymbol.get(candle.symbol) ?? [];
    bars.push(candle);
    barsBySymbol.set(candle.symbol, bars);
  }
  for (const bars of barsBySymbol.values()) bars.sort((a, b) => a.ts - b.ts);

  const run = runScan({
    scanDate: request.scanDate,
    members: universe.members,
    universeRejected: universe.rejected,
    barsBySymbol,
    holidays: request.holidays,
    specialSessions: request.specialSessions,
    ...(request.conditions === undefined
      ? {}
      : { conditions: request.conditions }),
  });
  const manifest: ScanManifest = {
    universeVersion: SCAN_UNIVERSE_VERSION,
    universeAsOf,
    minDaysToExpiry: request.minDaysToExpiry,
    symbolFiles: {
      foSha256: sha256(request.files.fo),
      cmSha256: sha256(request.files.cm),
    },
    holidays: [...request.holidays].sort(),
    specialSessions: [...request.specialSessions].sort(),
    historyDays: SCAN_HISTORY_DAYS,
  };
  if (!request.save) return { run, manifest, saved: false };

  const saved = await new StrategyExperimentsRepository(db).save({
    experimentId: request.experimentId,
    kind: "SCAN",
    createdAt: request.createdAt,
    fingerprint: run.fingerprint,
    manifest: manifest as unknown as Record<string, unknown>,
    result: run.result as unknown as Record<string, unknown>,
  });
  return { run, manifest, saved };
}

/** Fetch the two public symbol files. No token: they are published openly. */
export async function fetchSymbolFiles(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ fo: string; cm: string }> {
  const get = async (url: string): Promise<string> => {
    const response = await fetchImpl(url);
    if (!response.ok)
      throw new Error(
        `symbol file ${url} answered HTTP ${String(response.status)}`,
      );
    return response.text();
  };
  const [fo, cm] = await Promise.all([
    get(SYMBOL_FILE_URLS.fo),
    get(SYMBOL_FILE_URLS.cm),
  ]);
  return { fo, cm };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
