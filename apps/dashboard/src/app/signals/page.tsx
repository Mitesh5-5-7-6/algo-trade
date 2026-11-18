"use client";

import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import { describeVerdict, pct } from "@/lib/odds";
import { qk } from "@/lib/query-keys";
import {
  bareSymbol,
  cardTime,
  describeBasis,
  price,
  type TradeCard,
} from "@/lib/trade-card";

const message = (error: unknown): string =>
  error instanceof ApiError || error instanceof Error
    ? error.message
    : "The request failed.";

/**
 * Signals — today's approved entries as trade cards (operator decision
 * 2026-11-18): what to buy, the buy price, the stop and the target, in
 * premium and in points. The same cards go to Telegram.
 */
export default function SignalsPage() {
  const cards = useQuery({
    queryKey: qk.tradeCards,
    queryFn: api.tradeCards,
    refetchInterval: 15_000,
  });

  return (
    <>
      <h1 className="page-title">Signals</h1>
      <p className="hint" style={{ marginBottom: 16 }}>
        Today&apos;s entries that passed the Risk Engine, newest first. Paper
        trading has already acted on each; these are the numbers to trade it by
        hand.
      </p>
      {cards.isError && <p className="login-error">{message(cards.error)}</p>}
      {cards.isPending && <p className="hint">Loading today&apos;s signals…</p>}
      {cards.data !== undefined && cards.data.length === 0 && (
        <section className="panel">
          <p className="hint">No approved entry yet today.</p>
        </section>
      )}
      <div className="trade-cards">
        {cards.data?.map((card) => (
          <Card key={card.signalId} card={card} />
        ))}
      </div>
    </>
  );
}

function Card({ card }: { card: TradeCard }) {
  const what =
    card.contract === null
      ? bareSymbol(card.underlying)
      : bareSymbol(card.contract);
  return (
    <section className="panel trade-card">
      <div className="trade-card-head">
        <span className={card.direction === "BULLISH" ? "pos" : "neg"}>
          {card.action}
        </span>{" "}
        <strong className="mono">{what}</strong>
        <span className="hint">
          {" "}
          · {cardTime(card.ts)} · {card.strategyName}
        </span>
      </div>
      <table className="data odds-table">
        <tbody>
          <tr>
            <td>{card.action === "BUY" ? "Buy price" : "Sell price"}</td>
            <td className="num mono">{price(card.entry)}</td>
          </tr>
          <tr>
            <td>Stop-loss</td>
            <td className="num mono">
              {price(card.stopLoss)}
              {card.stopPoints !== null && ` (${price(card.stopPoints)} pts)`}
            </td>
          </tr>
          <tr>
            <td>Target</td>
            <td className="num mono">
              {price(card.target)}
              {card.targetPoints !== null &&
                ` (${price(card.targetPoints)} pts)`}
            </td>
          </tr>
          <tr>
            <td>Reward : risk</td>
            <td className="num mono">
              {card.rewardRisk === null ? "—" : `${price(card.rewardRisk)} : 1`}
            </td>
          </tr>
          {card.lotSize !== null && (
            <tr>
              <td>Lot size</td>
              <td className="num mono">{card.lotSize}</td>
            </tr>
          )}
          {card.index !== null && (
            <tr>
              <td>{bareSymbol(card.underlying)} levels</td>
              <td className="num mono">
                {price(card.index.entry)} · SL {price(card.index.stopLoss)} ·
                target {price(card.index.target)}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <Odds card={card} />
      <p className="hint">{card.reason}</p>
      <p className="hint">{describeBasis(card)}.</p>
      {card.note !== null && <p className="hint">{card.note}.</p>}
    </section>
  );
}

/** The Time Machine's odds for the card's plan, as the research service gave them. */
function Odds({ card }: { card: TradeCard }) {
  const odds = card.odds;
  if (odds === undefined) return <p className="hint">Time Machine: asking…</p>;
  if (odds.status !== "OK")
    return (
      <p className="hint">
        Time Machine {odds.status === "NOT_RUN" ? "not run" : "unavailable"}:{" "}
        {odds.reason}.
      </p>
    );
  const tone = describeVerdict(odds.verdict ?? "").tone;
  return (
    <>
      <p className={`odds-verdict ${tone}`} style={{ marginTop: 8 }}>
        Time Machine: {describeVerdict(odds.verdict ?? "").label}
      </p>
      <table className="data odds-table">
        <tbody>
          <tr>
            <td>Target first / stop first / neither</td>
            <td className="num mono">
              {pct(odds.targetFirst)} / {pct(odds.stopFirst)} /{" "}
              {pct(odds.neither)}
            </td>
          </tr>
          <tr>
            <td>Break-even share</td>
            <td className="num mono">{pct(odds.breakEven)}</td>
          </tr>
          <tr>
            <td>Replays</td>
            <td className="num mono">
              {(odds.replays ?? 0).toLocaleString("en-IN")} of{" "}
              {odds.sessions ?? 0} sessions
            </td>
          </tr>
          {odds.history !== null && (
            <tr>
              <td>{odds.history.rule} over real history</td>
              <td className="num mono">
                {odds.history.fired} trades,{" "}
                {odds.history.averageR === null
                  ? "—"
                  : `${odds.history.averageR.toFixed(2)}R`}{" "}
                — {describeVerdict(odds.history.verdict).label}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {odds.plan?.estimated === true && (
        <p className="hint">
          Asked on the index: {odds.plan.side} {price(odds.plan.entry)}, SL{" "}
          {price(odds.plan.stop)}, target {price(odds.plan.target)} —{" "}
          {odds.reason}.
        </p>
      )}
    </>
  );
}
