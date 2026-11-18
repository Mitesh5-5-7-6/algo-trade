import type { TradeCard } from "@neelkanth/core";

const num = (value: number): string =>
  value.toLocaleString("en-IN", { maximumFractionDigits: 2 });

const istTime = (ts: number): string =>
  new Date(ts + 19_800_000).toISOString().slice(11, 16);

const istDate = (ts: number): string => {
  const d = new Date(ts + 19_800_000);
  return `${String(d.getUTCDate())} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()] ?? ""}`;
};

/** `NSE:BANKNIFTY26NOV62100CE` → `BANKNIFTY26NOV62100CE`. */
const bare = (symbol: string): string => symbol.replace(/^[A-Z]+:/, "");

/**
 * A trade card as a Telegram message: a title naming what to buy and at what,
 * and a body with the stop, the target, the points and what the numbers rest
 * on. Plain text — the notifier sends no markup.
 */
export function formatTradeCard(card: TradeCard): {
  title: string;
  body: string;
} {
  const what =
    card.contract === null ? bare(card.underlying) : bare(card.contract);
  const title =
    card.entry === null
      ? `${card.action} ${what} — ${card.direction.toLowerCase()} signal, premium unknown`
      : `${card.action} ${what} @ ${num(card.entry)}`;

  const lines = [
    `${card.strategyName} at ${istTime(card.ts)} — ${card.reason}`,
  ];
  if (card.entry !== null) {
    const parts = [`Buy price ${num(card.entry)}`];
    if (card.action === "SELL") parts[0] = `Sell price ${num(card.entry)}`;
    if (card.stopLoss !== null)
      parts.push(`SL ${num(card.stopLoss)} (${num(card.stopPoints ?? 0)} pts)`);
    if (card.target !== null)
      parts.push(
        `Target ${num(card.target)} (${num(card.targetPoints ?? 0)} pts)`,
      );
    if (card.rewardRisk !== null) parts.push(`R:R ${num(card.rewardRisk)}`);
    lines.push(parts.join(" · "));
  }
  if (card.lotSize !== null || card.expiry !== null)
    lines.push(
      [
        card.lotSize === null ? null : `Lot ${String(card.lotSize)}`,
        card.expiry === null ? null : `expiry ${istDate(card.expiry)}`,
      ]
        .filter((p): p is string => p !== null)
        .join(" · "),
    );
  if (card.index !== null)
    lines.push(
      `${bare(card.underlying)}: entry ${num(card.index.entry)}` +
        (card.index.stopLoss === null
          ? ""
          : ` · SL ${num(card.index.stopLoss)}`) +
        (card.index.target === null
          ? ""
          : ` · target ${num(card.index.target)}`),
    );
  if (card.estimated)
    lines.push(
      `Premium SL and target are estimates from the index levels at delta ${String(card.assumedDelta ?? 0.5)}; the option also moves with time and volatility.`,
    );
  if (card.note !== null) lines.push(card.note);
  return { title, body: lines.join("\n") };
}
