import type { CardOdds, TradeCard } from "@neelkanth/core";
import { ASSUMED_ATM_DELTA } from "./trade-card.js";

/**
 * A trade card's plan, asked of the Time Machine (operator decision
 * 2026-11-18): how often did the rest of the day reach the target before the
 * stop, from this time on past sessions — and how did the strategy's own rule
 * do over them?
 *
 * The odds are the research service's (design §6.1 D16). The trading process
 * only asks, after the order is placed, and waits a bounded time: a card
 * without odds still goes out, saying why.
 */

/** Rules the Time Machine can replay over the index's bars (as the dashboard's). */
export const REPLAYABLE_RULES = new Set(["ORB", "EMA_CROSSOVER", "RSI"]);

/** What `POST /odds` takes — the research service's own body. */
export interface OddsBody {
  symbol: string;
  side: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  date: string;
  time: string;
  rule?: { type: string; params: Record<string, unknown> };
  indexSymbols: string[];
  save: false;
}

export interface OddsPlanContext {
  /** The underlying's price now — needed to place an option strategy's levels. */
  spot: number | null;
  /** The strategy's type and params, when its history can be replayed. */
  rule: { type: string; params: Record<string, unknown> } | null;
  /** Indices the rule's replay reads for its market view. */
  indexSymbols: readonly string[];
  delta?: number;
}

const notRun = (reason: string): CardOdds => ({
  status: "NOT_RUN",
  reason,
  plan: null,
  replays: null,
  sessions: null,
  targetFirst: null,
  stopFirst: null,
  neither: null,
  breakEven: null,
  verdict: null,
  history: null,
  fingerprint: null,
});

export const unavailable = (
  reason: string,
  plan: CardOdds["plan"] = null,
): CardOdds => ({ ...notRun(reason), status: "UNAVAILABLE", plan });

const istClock = (ts: number): { date: string; time: string } => {
  const iso = new Date(ts + 19_800_000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The plan to ask about, on the underlying, or why none can be asked.
 *
 * An index strategy's card carries the index levels the strategy set. An
 * option strategy's carries premium levels only, so they are worked back to
 * the index at the same assumed delta the card uses the other way — and the
 * plan says it is estimated. A stock's has no stored 5-minute bars in the
 * research data, which holds the indices.
 */
export function oddsPlanFor(
  card: TradeCard,
  context: OddsPlanContext,
): { body: OddsBody; plan: NonNullable<CardOdds["plan"]> } | CardOdds {
  const side = card.direction === "BULLISH" ? "LONG" : "SHORT";
  const sign = side === "LONG" ? 1 : -1;
  let levels: { entry: number; stop: number; target: number } | null = null;
  let estimated = false;

  if (card.basis === "DIRECT")
    return notRun("the Time Machine holds index bars only, not this stock's");
  if (card.basis === "INDEX_SUGGESTED") {
    if (card.index?.stopLoss == null || card.index.target === null)
      return notRun("the strategy set no index stop or target to ask about");
    levels = {
      entry: card.index.entry,
      stop: card.index.stopLoss,
      target: card.index.target,
    };
  } else {
    if (card.entry === null || card.stopLoss === null || card.target === null)
      return notRun("the option strategy set no premium stop or target");
    if (context.spot === null || context.spot <= 0)
      return notRun(
        `${card.underlying} has no live price to place the plan on`,
      );
    const delta = context.delta ?? ASSUMED_ATM_DELTA;
    levels = {
      entry: round2(context.spot),
      stop: round2(
        context.spot - (sign * (card.entry - card.stopLoss)) / delta,
      ),
      target: round2(
        context.spot + (sign * (card.target - card.entry)) / delta,
      ),
    };
    estimated = true;
  }

  const { date, time } = istClock(card.ts);
  const rule =
    context.rule !== null && REPLAYABLE_RULES.has(context.rule.type)
      ? context.rule
      : null;
  const plan = { side, ...levels, estimated } as const;
  return {
    plan,
    body: {
      symbol: card.underlying,
      side,
      entry: levels.entry,
      stop: levels.stop,
      target: levels.target,
      date,
      time,
      ...(rule === null ? {} : { rule }),
      indexSymbols: [...context.indexSymbols],
      save: false,
    },
  };
}

/** The part of the research service's answer a card keeps. */
interface OddsAnswer {
  fingerprint?: string;
  manifest?: { pool?: { sessions?: number } };
  result?: {
    resampled?: {
      replays: number;
      targetFirst: number;
      stopFirst: number;
      neither: number;
    };
    resampledVerdict?: { breakEven: number; verdict: string };
    historyVerdict?: {
      fired: number;
      averageR: number | null;
      verdict: string;
    } | null;
  };
}

/** The answer as card odds — the service's numbers, as shares of the replays. */
export function summarizeOdds(
  answer: unknown,
  plan: NonNullable<CardOdds["plan"]>,
  ruleType: string | null,
): CardOdds {
  const a = answer as OddsAnswer;
  const r = a.result?.resampled;
  const v = a.result?.resampledVerdict;
  if (r === undefined || v === undefined || r.replays <= 0)
    return unavailable("the research service's answer held no odds", plan);
  const share = (n: number) => round2((n / r.replays) * 10_000) / 10_000;
  const h = a.result?.historyVerdict ?? null;
  return {
    status: "OK",
    reason: plan.estimated
      ? `levels worked back from the premium at delta ${String(ASSUMED_ATM_DELTA)}`
      : null,
    plan,
    replays: r.replays,
    sessions: a.manifest?.pool?.sessions ?? null,
    targetFirst: share(r.targetFirst),
    stopFirst: share(r.stopFirst),
    neither: share(r.neither),
    breakEven: v.breakEven,
    verdict: v.verdict,
    history:
      h === null || ruleType === null
        ? null
        : {
            rule: ruleType,
            fired: h.fired,
            averageR: h.averageR,
            verdict: h.verdict,
          },
    fingerprint: a.fingerprint ?? null,
  };
}

/** How the trading process reaches the research service: a status and a body. */
export type AskOdds = (
  body: OddsBody,
) => Promise<{ status: number; body: unknown }>;

/**
 * Ask, and turn whatever happens into card odds: the answer, the service's
 * own refusal in its words, or that it did not answer. Never throws.
 */
export async function oddsForCard(
  card: TradeCard,
  context: OddsPlanContext,
  ask: AskOdds | null,
): Promise<CardOdds> {
  if (ask === null)
    return notRun("the research service is not configured for this deployment");
  const planned = oddsPlanFor(card, context);
  if (!("body" in planned)) return planned;
  try {
    const answer = await ask(planned.body);
    if (answer.status === 200)
      return summarizeOdds(
        answer.body,
        planned.plan,
        planned.body.rule?.type ?? null,
      );
    const message = (answer.body as { error?: { message?: string } } | null)
      ?.error?.message;
    return unavailable(
      `the research service answered ${String(answer.status)}${message === undefined ? "" : `: ${message}`}`,
      planned.plan,
    );
  } catch (error) {
    return unavailable(
      `the research service did not answer: ${error instanceof Error ? error.message : String(error)}`,
      planned.plan,
    );
  }
}
