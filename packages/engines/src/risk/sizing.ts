import type { FnoSizingLog, Instrument, RiskLimits } from "@neelkanth/core";
import type { PortfolioSnapshot } from "./ports.js";

/**
 * Position sizing, split by instrument class (plan/14 §4.4).
 *
 * Equity and derivatives are sized by different arithmetic, and conflating
 * them is what produced blocks like "one lot of 60 does not fit in 44": a
 * share capacity of 44 was computed first and a 60-share lot floored out of
 * it. That is the wrong question. A derivative's smallest tradable unit is one
 * LOT, so every capacity must be expressed in lots from the start, and the
 * answer is the smallest of them.
 *
 * Both paths are pure functions of their inputs so the arithmetic is testable
 * without a risk engine, a clock, or infrastructure.
 */

/** Limits after F&O fields fall back to their equity counterparts. */
export interface FnoLimits {
  riskPerTrade: number;
  maxCapitalPerTrade: number;
  maxExposure: number;
  maxOpenPositions: number;
  /** Null when no explicit lot ceiling is configured. */
  maxLotsPerTrade: number | null;
}

/**
 * Resolve the F&O budget from the operator's limits.
 *
 * Each F&O field falls back to its equity counterpart when unset, so an
 * operator who has not configured derivatives separately is held to the limits
 * already in force — never to looser ones. `fnoRiskPerTrade` deliberately has
 * no widened default: if one lot risks more than the equity budget allows, the
 * correct outcome is a block and a configuration decision, not a budget that
 * quietly grew to fit the trade.
 */
export function resolveFnoLimits(limits: RiskLimits): FnoLimits {
  return {
    riskPerTrade: limits.fnoRiskPerTrade ?? limits.riskPerTrade,
    maxCapitalPerTrade:
      limits.fnoMaxCapitalPerTrade ?? limits.maxCapitalPerTrade,
    maxExposure: limits.fnoMaxExposure ?? limits.maxExposure,
    maxOpenPositions: limits.fnoMaxOpenPositions ?? limits.maxOpenPositions,
    maxLotsPerTrade: limits.fnoMaxLotsPerTrade ?? null,
  };
}

/** The two derivative classes, which do NOT cost the same thing per lot. */
export type FnoInstrumentType = "OPTION" | "FUTURE";

/**
 * What `capitalPerLot` actually measures — recorded because the two are not
 * interchangeable and a reader must never have to guess which one they have.
 *
 *  - `PREMIUM`  — an option buyer's real cash outlay: `premium × lotSize`.
 *    Exact. It is the whole amount at risk.
 *  - `NOTIONAL` — a future's contract value: `price × lotSize`. This is NOT
 *    the margin posted, which is a fraction of it. Used as a deliberately
 *    conservative stand-in until broker margin data exists.
 */
export type CapitalBasis = "PREMIUM" | "NOTIONAL";

export interface FnoSizingInput {
  symbol: string;
  instrument: Instrument;
  entryPrice: number;
  stopPrice: number;
  portfolio: PortfolioSnapshot;
  limits: FnoLimits;
  /** Open positions now — only consulted when this signal opens a new one. */
  openPositionCount: number;
  /** True when this signal would open a position rather than add to one. */
  opensNewPosition: boolean;
  /** The strategy's own ceiling, in CONTRACTS, or undefined. */
  qtyProposal?: number;
}

/**
 * The capital one lot ties up, by instrument class.
 *
 * Options and futures are split explicitly rather than sharing one formula,
 * because they are only accidentally the same expression. An option buyer pays
 * the premium and that is the whole cost; a futures trader posts margin, which
 * is a fraction of the notional this returns.
 *
 * **No margin percentage is invented here.** A hardcoded "futures margin = 15%"
 * would be made-up precision that reads as fact everywhere downstream. Until a
 * broker/exchange margin figure is available, futures are sized against the
 * full notional — which can only make positions smaller than reality requires,
 * never larger. This function is the seam a real margin provider plugs into:
 *
 *   Broker margin API → futures margin provider → here
 */
export function capitalPerLotFor(
  instrumentType: FnoInstrumentType,
  entryPrice: number,
  lotSize: number,
): { capitalPerLot: number; basis: CapitalBasis } {
  if (instrumentType === "OPTION") {
    // Premium paid, in full. Exact for a buyer.
    return { capitalPerLot: entryPrice * lotSize, basis: "PREMIUM" };
  }
  // Contract notional, standing in for margin. Conservative, and labelled as
  // notional so nothing downstream mistakes it for the amount actually posted.
  return { capitalPerLot: entryPrice * lotSize, basis: "NOTIONAL" };
}

/**
 * The full F&O sizing derivation — every intermediate value kept, so a blocked
 * trade can say which capacity bound and by how much.
 */
export interface FnoSizingResult {
  readonly kind: "FNO";
  readonly symbol: string;
  readonly instrumentType: FnoInstrumentType;
  /** Whether `capitalPerLot` is a premium paid or a futures notional. */
  readonly capitalBasis: CapitalBasis;
  readonly lotSize: number;
  readonly entryPrice: number;
  readonly stopPrice: number;
  readonly stopDistance: number;
  readonly riskPerLot: number;
  readonly capitalPerLot: number;
  readonly riskBudget: number;
  readonly lotsByRisk: number;
  readonly lotsByCapital: number;
  readonly lotsByExposure: number;
  /** Null when no lot ceiling is configured. */
  readonly lotsByMaxLotsPerTrade: number | null;
  /** 0 when the open-position cap is reached; null when it does not apply. */
  readonly lotsByMaxOpenPositions: number | null;
  /** Null when the strategy proposed no ceiling. */
  readonly lotsByProposal: number | null;
  readonly allowedLots: number;
  readonly quantity: number;
  readonly blockedReason: string | null;
}

/** Floor a capacity to whole lots, never below zero. */
function wholeLots(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Size an F&O order in whole lots.
 *
 * Each capacity is computed independently and in the same unit:
 *
 *   riskPerLot     = |entry − stop| × lotSize
 *   capitalPerLot  = entry × lotSize
 *   lotsByRisk     = riskBudget      ÷ riskPerLot
 *   lotsByCapital  = capital ceiling ÷ capitalPerLot
 *   lotsByExposure = exposure left   ÷ capitalPerLot
 *
 * `allowedLots` is their minimum, floored, and `quantity = allowedLots ×
 * lotSize` — so a partial lot is not merely rejected, it is unrepresentable.
 * Fewer than one whole lot blocks.
 *
 * NOTE on futures: `capitalPerLot` is the notional (`price × lotSize`), which
 * for a future is far more than the margin actually posted. That makes the
 * capital and exposure capacities conservative rather than wrong, and sizing
 * may only err toward being too small. Replacing it with a real margin figure
 * needs broker margin data and is deliberately not guessed here.
 */
export function sizeFno(input: FnoSizingInput): FnoSizingResult {
  const { instrument, entryPrice, stopPrice, portfolio, limits } = input;
  const lotSize = instrument.lotSize;
  const instrumentType: FnoInstrumentType =
    instrument.kind === "FUTURE" ? "FUTURE" : "OPTION";
  const stopDistance = Math.abs(entryPrice - stopPrice);
  // Stop risk is the same shape for both classes: the stop is on the traded
  // instrument's own price, so a lot loses `distance × lotSize` either way.
  const riskPerLot = stopDistance * lotSize;
  const { capitalPerLot, basis: capitalBasis } = capitalPerLotFor(
    instrumentType,
    entryPrice,
    lotSize,
  );
  const riskBudget = limits.riskPerTrade * portfolio.allocatedCapital;

  const base = {
    kind: "FNO",
    symbol: input.symbol,
    instrumentType,
    capitalBasis,
    lotSize,
    entryPrice,
    stopPrice,
    stopDistance,
    riskPerLot,
    capitalPerLot,
    riskBudget,
  } as const;

  const blocked = (
    reason: string,
    partial: Partial<FnoSizingResult> = {},
  ): FnoSizingResult => ({
    ...base,
    lotsByRisk: 0,
    lotsByCapital: 0,
    lotsByExposure: 0,
    lotsByMaxLotsPerTrade: limits.maxLotsPerTrade,
    lotsByMaxOpenPositions: null,
    lotsByProposal: null,
    allowedLots: 0,
    quantity: 0,
    blockedReason: reason,
    ...partial,
  });

  // A stop is the denominator of the whole calculation. Without a usable one
  // there is no risk-based size, only a number someone made up.
  if (stopDistance <= 0) {
    return blocked(
      `stop ${String(stopPrice)} equals entry ${String(entryPrice)} — undefined risk per lot`,
    );
  }
  if (capitalPerLot <= 0) {
    return blocked(`entry price ${String(entryPrice)} is not tradable`);
  }

  // The open-position cap is a gate, not a capacity: at the cap, no new
  // position of any size is permitted.
  const lotsByMaxOpenPositions = input.opensNewPosition
    ? input.openPositionCount >= limits.maxOpenPositions
      ? 0
      : null
    : null;
  if (lotsByMaxOpenPositions === 0) {
    return blocked(
      `open F&O positions ${String(input.openPositionCount)} ≥ max ${String(limits.maxOpenPositions)}`,
      { lotsByMaxOpenPositions: 0 },
    );
  }

  const exposureBudget =
    limits.maxExposure * portfolio.allocatedCapital - portfolio.investedValue;
  const capitalCeiling = Math.min(
    limits.maxCapitalPerTrade,
    portfolio.availableCapital,
  );

  const lotsByRisk = wholeLots(riskBudget / riskPerLot);
  const lotsByCapital = wholeLots(capitalCeiling / capitalPerLot);
  const lotsByExposure = wholeLots(exposureBudget / capitalPerLot);
  const lotsByMaxLotsPerTrade = limits.maxLotsPerTrade;
  // A strategy proposes contracts; converting to lots keeps the comparison in
  // one unit instead of pitting a contract count against a lot count.
  const lotsByProposal =
    input.qtyProposal === undefined
      ? null
      : wholeLots(input.qtyProposal / lotSize);

  const capacities: number[] = [lotsByRisk, lotsByCapital, lotsByExposure];
  if (lotsByMaxLotsPerTrade !== null) capacities.push(lotsByMaxLotsPerTrade);
  if (lotsByProposal !== null) capacities.push(lotsByProposal);
  const allowedLots = Math.max(0, Math.min(...capacities));

  const sized: Omit<
    FnoSizingResult,
    "allowedLots" | "quantity" | "blockedReason"
  > = {
    ...base,
    lotsByRisk,
    lotsByCapital,
    lotsByExposure,
    lotsByMaxLotsPerTrade,
    lotsByMaxOpenPositions,
    lotsByProposal,
  };

  if (allowedLots < 1) {
    return {
      ...sized,
      allowedLots: 0,
      quantity: 0,
      blockedReason: describeShortfall({
        lotsByRisk,
        lotsByCapital,
        lotsByExposure,
        lotsByMaxLotsPerTrade,
        lotsByProposal,
        riskPerLot,
        riskBudget,
        capitalPerLot,
        capitalCeiling,
        exposureBudget,
      }),
    };
  }

  return {
    ...sized,
    allowedLots,
    // Whole lots by construction — a partial lot cannot be expressed.
    quantity: allowedLots * lotSize,
    blockedReason: null,
  };
}

interface ShortfallInput {
  lotsByRisk: number;
  lotsByCapital: number;
  lotsByExposure: number;
  lotsByMaxLotsPerTrade: number | null;
  lotsByProposal: number | null;
  riskPerLot: number;
  riskBudget: number;
  capitalPerLot: number;
  capitalCeiling: number;
  exposureBudget: number;
}

/**
 * Name the binding constraint in the operator's terms.
 *
 * "one lot of 60 does not fit in 44" is technically true and practically
 * useless: it names neither which budget ran out nor by how much. Each branch
 * here states the requirement and the availability, in rupees, so the next
 * action — widen the budget, or accept the block — is obvious.
 */
function describeShortfall(input: ShortfallInput): string {
  const money = (value: number): string => `₹${Math.round(value).toString()}`;
  if (input.lotsByRisk < 1) {
    return (
      `one lot risks ${money(input.riskPerLot)} but the F&O risk budget is ` +
      `${money(input.riskBudget)} — ONE LOT EXCEEDS RISK BUDGET`
    );
  }
  if (input.lotsByCapital < 1) {
    return (
      `one lot costs ${money(input.capitalPerLot)} but only ` +
      `${money(input.capitalCeiling)} may be committed to one F&O trade`
    );
  }
  if (input.lotsByExposure < 1) {
    return (
      `one lot costs ${money(input.capitalPerLot)} but only ` +
      `${money(input.exposureBudget)} of F&O exposure headroom remains`
    );
  }
  if (input.lotsByProposal !== null && input.lotsByProposal < 1) {
    return "the strategy proposed less than one whole lot";
  }
  return "no whole lot fits within the configured F&O limits";
}

/** Flatten a sizing result into the persisted log record (plan/14 §7). */
export function toFnoSizingLog(result: FnoSizingResult): FnoSizingLog {
  return {
    symbol: result.symbol,
    instrumentType: result.instrumentType,
    capitalBasis: result.capitalBasis,
    lotSize: result.lotSize,
    entryPrice: result.entryPrice,
    stopPrice: result.stopPrice,
    stopDistance: result.stopDistance,
    riskPerLot: result.riskPerLot,
    capitalPerLot: result.capitalPerLot,
    riskBudget: result.riskBudget,
    riskCapacityLots: result.lotsByRisk,
    capitalCapacityLots: result.lotsByCapital,
    exposureCapacityLots: result.lotsByExposure,
    maxLotsPerTrade: result.lotsByMaxLotsPerTrade,
    openPositionCapacityLots: result.lotsByMaxOpenPositions,
    allowedLots: result.allowedLots,
    finalQuantity: result.quantity,
    blockedReason: result.blockedReason,
  };
}

/** A one-line summary for the risk-check audit trail. */
export function describeFnoSizing(result: FnoSizingResult): string {
  const cap = (label: string, value: number | null): string =>
    value === null ? "" : ` ${label}=${String(value)}`;
  return (
    `lot=${String(result.lotSize)} riskPerLot=₹${result.riskPerLot.toFixed(0)} ` +
    `capitalPerLot=₹${result.capitalPerLot.toFixed(0)} ` +
    `budget=₹${result.riskBudget.toFixed(0)} | lots: risk=${String(result.lotsByRisk)}` +
    ` capital=${String(result.lotsByCapital)} exposure=${String(result.lotsByExposure)}` +
    cap("max", result.lotsByMaxLotsPerTrade) +
    cap("proposal", result.lotsByProposal) +
    ` → allowed=${String(result.allowedLots)} qty=${String(result.quantity)}`
  );
}

export interface EquitySizingInput {
  entryPrice: number;
  stopPrice: number;
  portfolio: PortfolioSnapshot;
  limits: RiskLimits;
  /** Equity lot size — 1 for the cash market. */
  lotSize: number;
  qtyProposal?: number;
}

export interface EquitySizingResult {
  readonly kind: "EQUITY";
  readonly riskPerUnit: number;
  readonly riskBudget: number;
  readonly byRisk: number;
  readonly byCapital: number;
  readonly byAvailable: number;
  readonly byExposure: number;
  readonly quantity: number;
  readonly blockedReason: string | null;
}

/**
 * Size a cash-equity order in shares — the original arithmetic, unchanged in
 * behaviour and now confined to the instrument class it was written for.
 */
export function sizeEquity(input: EquitySizingInput): EquitySizingResult {
  const { entryPrice, stopPrice, portfolio, limits, lotSize } = input;
  const riskPerUnit = Math.abs(entryPrice - stopPrice);
  const riskBudget = limits.riskPerTrade * portfolio.allocatedCapital;

  const fail = (reason: string): EquitySizingResult => ({
    kind: "EQUITY",
    riskPerUnit,
    riskBudget,
    byRisk: 0,
    byCapital: 0,
    byAvailable: 0,
    byExposure: 0,
    quantity: 0,
    blockedReason: reason,
  });

  if (riskPerUnit <= 0) {
    return fail(
      `stop ${String(stopPrice)} equals entry ${String(entryPrice)} — undefined risk`,
    );
  }

  const byRisk = Math.floor(riskBudget / riskPerUnit);
  const byCapital = Math.floor(limits.maxCapitalPerTrade / entryPrice);
  const byAvailable = Math.floor(portfolio.availableCapital / entryPrice);
  const exposureBudget =
    limits.maxExposure * portfolio.allocatedCapital - portfolio.investedValue;
  const byExposure = Math.floor(exposureBudget / entryPrice);

  const unrounded = Math.min(
    byRisk,
    limits.maxPositionSize,
    byCapital,
    byAvailable,
    byExposure,
    ...(input.qtyProposal === undefined ? [] : [input.qtyProposal]),
  );
  // Down to whole lots, never up: rounding up exceeds whichever limit was
  // binding, which is the one direction sizing must never err in.
  const quantity =
    lotSize <= 0 ? 0 : Math.floor(Math.max(0, unrounded) / lotSize) * lotSize;

  return {
    kind: "EQUITY",
    riskPerUnit,
    riskBudget,
    byRisk,
    byCapital,
    byAvailable,
    byExposure,
    quantity,
    blockedReason:
      quantity > 0 ? null : "no capacity within risk/exposure limits",
  };
}
