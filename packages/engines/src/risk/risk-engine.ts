import type {
  Position,
  RiskCheckName,
  RiskCheckResult,
  RiskDecision,
  RiskLimits,
  Signal,
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
 * asymmetry (plan/14 §5) exempts risk-reducing signals from the daily-loss and
 * size/exposure checks — when limits are breached the machine may still get
 * *out* of positions, never *into* new ones. Fail-closed throughout: if risk
 * state can't be read, block (plan/14 §9).
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

      // --- Check 3: daily loss (risk-increasing only, plan/14 §4.3, §5) ---
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

      // --- Check 4: size / exposure (risk-increasing only, plan/14 §4.4, §5) ---
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

  /** Cap (never invent) the proposed quantity against size/exposure limits. */
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
    const proposed = signal.qtyProposal;
    if (proposed === undefined) {
      return {
        blocked: true,
        reason: "no proposed quantity to size",
        result: {
          check: "positionSize",
          passed: false,
          detail: "no qtyProposal",
        },
      };
    }

    // Opening a new position must respect the max-open-positions cap.
    if (position === null) {
      const openCount = await this.ports.readOpenPositionCount();
      if (openCount >= limits.maxOpenPositions) {
        return {
          blocked: true,
          reason: `open positions ${String(openCount)} ≥ max ${String(limits.maxOpenPositions)}`,
          result: {
            check: "positionSize",
            passed: false,
            detail: "max open positions reached",
          },
        };
      }
    }

    const price = signal.contextSnapshot.price;
    const portfolio = await this.ports.readPortfolio();
    const capByCapital = Math.floor(limits.maxCapitalPerTrade / price);
    const capByAvailable = Math.floor(portfolio.availableCapital / price);
    const exposureBudget =
      limits.maxExposure * portfolio.allocatedCapital - portfolio.investedValue;
    const capByExposure = Math.floor(exposureBudget / price);

    const qty = Math.min(
      proposed,
      limits.maxPositionSize,
      capByCapital,
      capByAvailable,
      capByExposure,
    );

    if (qty <= 0) {
      return {
        blocked: true,
        reason: "no capacity within size/exposure limits",
        result: {
          check: "positionSize",
          passed: false,
          detail: `capacity exhausted (proposed ${String(proposed)})`,
        },
      };
    }

    const cappedQty = qty < proposed ? qty : undefined;
    return {
      blocked: false,
      reason: "",
      ...(cappedQty === undefined ? {} : { cappedQty }),
      result: {
        check: "positionSize",
        passed: true,
        detail:
          cappedQty === undefined
            ? `within limits (${String(qty)})`
            : `capped ${String(proposed)} → ${String(qty)}`,
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
