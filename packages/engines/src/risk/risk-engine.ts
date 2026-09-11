import {
  contradictsMarket,
  floorToLots,
  type Position,
  type RiskCheckName,
  type RiskCheckResult,
  type RiskDecision,
  type RiskLimits,
  type Signal,
} from "@neelkanth/core";
import { resolveLimits } from "./resolve-limits.js";
import type { RiskPorts } from "./ports.js";

export interface RiskEngineDeps {
  ports: RiskPorts;
  nextLogId?: () => string;
  /** Required error sink — no silent failures (plan/02 §10). */
  onError: (error: unknown, context: Record<string, unknown>) => void;
}

/**
 * The Risk Engine (plan/14): the pre-execution gate. Every signal passes its
 * checks before the Order Manager may submit — the last component that can say
 * "no" while "no" still costs nothing (plan/14 §1). Output is binary
 * (approved | blocked-with-reason); every decision, both ways, is logged
 * (plan/14 §7).
 *
 * `validate()` is called SYNCHRONOUSLY on the critical path (plan/02 §6, Regime
 * A, plan/14 §2): the duplicate and exposure checks must be atomic with order
 * placement, so this must never be separated from placement by a queue.
 *
 * Checks run cheapest-and-most-absolute first (plan/14 §4). The entry/exit
 * asymmetry (plan/14 §5) exempts risk-reducing signals from the market-bias,
 * daily-loss and size/exposure checks — when limits are breached, or the
 * market has turned, the machine may still get *out* of positions, never
 * *into* new ones. Fail-closed throughout: if risk state can't be read, block
 * (plan/14 §9).
 *
 * This engine also **sizes** the order (§4.4). It is the only component that
 * can: the strategy knows its setup and its stop, but not the capital, the
 * open exposure, or the contract's lot size. A strategy's `qtyProposal` is
 * therefore read as a ceiling on intent, not as the quantity to trade.
 */
export class RiskEngine {
  private readonly ports: RiskPorts;
  private readonly onError: RiskEngineDeps["onError"];

  constructor(deps: RiskEngineDeps) {
    this.ports = deps.ports;
    this.onError = deps.onError;
  }

  async validate(signal: Signal): Promise<RiskDecision> {
    const checks: RiskCheckResult[] = [];
    let stage: RiskCheckName = "session";
    try {
      const limits = resolveLimits(
        await this.ports.readGlobalLimits(),
        await this.ports.readStrategyOverride(signal.strategyId),
      );
      const position = await this.ports.readPosition(
        signal.strategyId,
        signal.symbol,
      );
      const riskIncreasing = isRiskIncreasing(signal, position);

      // --- Check 1: session (absolute; applies to exits too, plan/14 §4.1) ---
      stage = "session";
      const session = await this.ports.readSession();
      const sessionOk = session === "open";
      checks.push({ check: "session", passed: sessionOk, detail: session });
      if (!sessionOk) {
        return await this.finish(signal, checks, {
          decision: "blocked",
          failedCheck: "session",
          reason: `market not open (session: ${session})`,
        });
      }

      // --- Check 2: duplicate (applies to exits too, plan/14 §4.2, §5) ---
      stage = "duplicate";
      const duplicate = await this.ports.hasInflightIntent(
        signal.strategyId,
        signal.symbol,
        signal.side === "BUY" ? "BUY" : "SELL",
      );
      checks.push({ check: "duplicate", passed: !duplicate });
      if (duplicate) {
        return await this.finish(signal, checks, {
          decision: "blocked",
          failedCheck: "duplicate",
          reason: "equivalent intent already in flight or open",
        });
      }

      // --- Check 3: market bias (risk-increasing only, plan/14 §4, §5) ---
      // Reviewed BEFORE size is computed, so capital is never committed to a
      // direction the market as a whole contradicts. Exits are exempt by the
      // same asymmetry as every other non-absolute check: getting out is
      // always allowed, whatever the market is doing.
      stage = "marketBias";
      // HOLD never reaches the engine (the runner stops it), and it names no
      // direction, so it cannot contradict one.
      if (riskIncreasing && signal.side !== "HOLD") {
        const view = this.ports.readMarketView();
        const against = contradictsMarket(signal.side, view);
        checks.push({
          check: "marketBias",
          passed: !against,
          detail: `${view.bias} — ${view.detail}`,
        });
        if (against) {
          return await this.finish(signal, checks, {
            decision: "blocked",
            failedCheck: "marketBias",
            reason: `${signal.side} against a ${view.bias} market — ${view.detail}`,
          });
        }
      } else {
        checks.push({
          check: "marketBias",
          passed: true,
          detail: "risk-reducing — exempt (plan/14 §5)",
        });
      }

      // --- Check 4: daily loss (risk-increasing only, plan/14 §4.3, §5) ---
      stage = "dailyLoss";
      if (riskIncreasing) {
        const loss = await this.ports.readDailyRealizedLoss();
        const breach = loss >= limits.maxDailyLoss;
        checks.push({
          check: "dailyLoss",
          passed: !breach,
          detail: `realized loss ${String(loss)} vs limit ${String(limits.maxDailyLoss)}`,
        });
        if (breach) {
          return await this.finish(signal, checks, {
            decision: "blocked",
            failedCheck: "dailyLoss",
            reason: `daily realized loss ${String(loss)} ≥ limit ${String(limits.maxDailyLoss)}`,
          });
        }
      } else {
        checks.push({
          check: "dailyLoss",
          passed: true,
          detail: "risk-reducing — exempt (plan/14 §5)",
        });
      }

      // --- Check 5: size / exposure (risk-increasing only, plan/14 §4.4, §5) ---
      stage = "positionSize";
      if (!riskIncreasing) {
        checks.push({
          check: "positionSize",
          passed: true,
          detail: "risk-reducing — exempt (plan/14 §5)",
        });
        return await this.finish(signal, checks, { decision: "approved" });
      }

      const sizing = await this.evaluateSize(signal, position, limits);
      checks.push(sizing.result);
      if (sizing.blocked) {
        return await this.finish(signal, checks, {
          decision: "blocked",
          failedCheck: "positionSize",
          reason: sizing.reason,
        });
      }
      return await this.finish(
        signal,
        checks,
        sizing.cappedQty === undefined
          ? { decision: "approved" }
          : { decision: "approved", cappedQty: sizing.cappedQty },
      );
    } catch (error) {
      // Fail closed (plan/14 §9): an unverifiable signal is unapproved.
      this.onError(error, {
        where: "validate",
        signalId: signal.signalId,
        stage,
      });
      const decision: RiskDecision = {
        decision: "blocked",
        failedCheck: stage,
        reason: "risk state unavailable — fail closed (plan/14 §9)",
      };
      await this.finish(signal, checks, decision).catch((logError: unknown) => {
        this.onError(logError, {
          where: "failClosedLog",
          signalId: signal.signalId,
        });
      });
      return decision;
    }
  }

  /**
   * Size the order (plan/14 §4.4): risk budget ÷ stop distance, rounded down
   * to whole lots, then capped by every exposure limit.
   *
   * `riskPerTrade × allocatedCapital` is what the trade is allowed to lose;
   * `|price − stopLoss|` is what one unit loses if the stop is hit; the
   * quotient is the quantity that makes those equal. This is why a stop is
   * mandatory here — without one there is no denominator, and "risk" would be
   * a number nobody could name.
   *
   * A `qtyProposal` still caps the result: a strategy that says "at most one
   * lot" is respected. It just no longer *sets* the size.
   */
  private async evaluateSize(
    signal: Signal,
    position: Position | null,
    limits: RiskLimits,
  ): Promise<{
    blocked: boolean;
    reason: string;
    cappedQty?: number;
    result: RiskCheckResult;
  }> {
    const block = (
      reason: string,
      detail: string,
    ): { blocked: true; reason: string; result: RiskCheckResult } => ({
      blocked: true,
      reason,
      result: { check: "positionSize", passed: false, detail },
    });

    // Opening a new position must respect the max-open-positions cap.
    if (position === null) {
      const openCount = await this.ports.readOpenPositionCount();
      if (openCount >= limits.maxOpenPositions) {
        return block(
          `open positions ${String(openCount)} ≥ max ${String(limits.maxOpenPositions)}`,
          "max open positions reached",
        );
      }
    }

    const price = signal.contextSnapshot.price;
    const stopLoss = signal.stopLoss;
    if (stopLoss === undefined) {
      return block(
        "entry has no stop — cannot size by risk",
        "no stopLoss on signal",
      );
    }
    const riskPerUnit = Math.abs(price - stopLoss);
    if (riskPerUnit <= 0) {
      return block(
        `stop ${String(stopLoss)} equals entry ${String(price)} — undefined risk`,
        "zero stop distance",
      );
    }

    // Lot size decides what a "unit" even is. Unknown symbol: equity is 1 by
    // definition, but a derivative's multiplier is not guessable and a wrong
    // one mis-sizes every order — so refuse rather than assume (plan/17 §7).
    const instrument = this.ports.readInstrument(signal.symbol);
    if (instrument === null && !signal.symbol.endsWith("-EQ")) {
      return block(
        `${signal.symbol} is not in the symbol master — lot size unknown`,
        "instrument unknown, non-equity",
      );
    }
    const lotSize = instrument?.lotSize ?? 1;

    const portfolio = await this.ports.readPortfolio();
    const riskBudget = limits.riskPerTrade * portfolio.allocatedCapital;
    const byRisk = Math.floor(riskBudget / riskPerUnit);

    const capByCapital = Math.floor(limits.maxCapitalPerTrade / price);
    const capByAvailable = Math.floor(portfolio.availableCapital / price);
    const exposureBudget =
      limits.maxExposure * portfolio.allocatedCapital - portfolio.investedValue;
    const capByExposure = Math.floor(exposureBudget / price);

    const ceiling = signal.qtyProposal;
    const unrounded = Math.min(
      byRisk,
      limits.maxPositionSize,
      capByCapital,
      capByAvailable,
      capByExposure,
      ...(ceiling === undefined ? [] : [ceiling]),
    );
    // Down to whole lots, never up: rounding up would exceed whichever limit
    // was binding, which is the one direction sizing must never err in.
    const qty = floorToLots(unrounded, lotSize);

    if (qty <= 0) {
      const shortfall =
        unrounded > 0
          ? `one lot of ${String(lotSize)} does not fit in ${String(unrounded)}`
          : "capacity exhausted";
      return block(
        `no capacity within risk/exposure limits — ${shortfall}`,
        `risk≤${String(byRisk)} cap≤${String(capByCapital)} avail≤${String(capByAvailable)} ` +
          `expo≤${String(capByExposure)} lot=${String(lotSize)}`,
      );
    }

    // ALWAYS returned, even when it equals the proposal. The Order Manager
    // falls back to `signal.qtyProposal` when this is absent, so omitting it
    // would silently trade the strategy's placeholder instead of the size the
    // risk budget just computed.
    return {
      blocked: false,
      reason: "",
      cappedQty: qty,
      result: {
        check: "positionSize",
        passed: true,
        detail:
          `qty ${String(qty)} (${String(qty / lotSize)} lot(s) of ${String(lotSize)}) — ` +
          `risk ₹${riskBudget.toFixed(0)} ÷ ₹${riskPerUnit.toFixed(2)}/unit = ${String(byRisk)}` +
          (qty < byRisk ? `, capped to ${String(qty)}` : ""),
      },
    };
  }

  /** Persist the log (both ways), emit RISK_BLOCKED on a block, and return. */
  private async finish(
    signal: Signal,
    checks: RiskCheckResult[],
    decision: RiskDecision,
  ): Promise<RiskDecision> {
    const blocked = decision.decision === "blocked";
    await this.ports.persistRiskLog({
      signalId: signal.signalId,
      strategyId: signal.strategyId,
      symbol: signal.symbol,
      decision: decision.decision,
      ...(blocked ? { failedCheck: decision.failedCheck } : {}),
      ...(blocked ? { reason: decision.reason } : {}),
      ...(decision.decision === "approved" && decision.cappedQty !== undefined
        ? { cappedQty: decision.cappedQty }
        : {}),
      checks,
      ts: signal.ts,
    });
    if (blocked) {
      await this.ports.publish(
        "RISK_BLOCKED",
        {
          signalId: signal.signalId,
          strategyId: signal.strategyId,
          symbol: signal.symbol,
          failedCheck: decision.failedCheck,
          reason: decision.reason,
          ts: signal.ts,
        },
        signal.signalId,
      );
    }
    return decision;
  }
}

/**
 * A signal is risk-reducing when it closes or trims the current position (an
 * opposite-side fill); otherwise it opens or adds and is risk-increasing
 * (plan/14 §5).
 */
export function isRiskIncreasing(
  signal: Signal,
  position: Position | null,
): boolean {
  if (position === null) return true;
  const reducing =
    (position.side === "LONG" && signal.side === "SELL") ||
    (position.side === "SHORT" && signal.side === "BUY");
  return !reducing;
}
