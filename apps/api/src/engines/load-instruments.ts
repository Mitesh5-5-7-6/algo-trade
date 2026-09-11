import {
  createInstrumentMaster,
  parseInstrumentFile,
  type InstrumentMaster,
} from "@neelkanth/broker";
import type { Instrument } from "@neelkanth/core";
import type { Logger } from "@neelkanth/logger";

/**
 * FYERS publishes the symbol master as headerless CSV, one file per segment,
 * refreshed daily. NSE_CM carries cash equity (lot size 1); NSE_FO carries the
 * futures and options whose lot sizes actually vary.
 */
const SEGMENT_URLS = [
  "https://public.fyers.in/sym_details/NSE_CM.csv",
  "https://public.fyers.in/sym_details/NSE_FO.csv",
] as const;

/** An empty master — every lookup misses. */
const EMPTY: InstrumentMaster = createInstrumentMaster([]);

/**
 * Download and index the symbol master (plan/17 §7).
 *
 * Deliberately **non-fatal**: a failed download leaves an empty master, and
 * the Risk Engine's sizing step then refuses derivatives (lot size unknowable)
 * while equities continue at their definitional lot size of 1. Booting is more
 * important than booting with derivatives — but a wrong lot size is worse than
 * no lot size, which is why the failure narrows what can trade instead of
 * guessing.
 *
 * The files are several MB, so this runs once at boot, off the tick path.
 */
export async function loadInstrumentMaster(
  log: Logger,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30_000,
): Promise<InstrumentMaster> {
  const all: Instrument[] = [];
  let totalSkipped = 0;

  for (const url of SEGMENT_URLS) {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        log.warn({ url, status: response.status }, "symbol master fetch failed");
        continue;
      }
      const { instruments, skipped } = parseInstrumentFile(
        await response.text(),
      );
      all.push(...instruments);
      totalSkipped += skipped;
      // A layout change shows up as most of a file being skipped, so the ratio
      // is the thing worth seeing — not the raw count.
      log.info(
        { url, parsed: instruments.length, skipped },
        "symbol master segment loaded",
      );
    } catch (error) {
      log.warn({ url, err: error }, "symbol master fetch errored");
    }
  }

  if (all.length === 0) {
    log.warn(
      {},
      "symbol master empty — derivatives cannot be sized until it loads",
    );
    return EMPTY;
  }
  const master = createInstrumentMaster(all);
  log.info({ instruments: master.size, skipped: totalSkipped }, "symbol master ready");
  return master;
}
