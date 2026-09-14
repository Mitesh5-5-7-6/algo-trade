import type { Order } from "@neelkanth/core";

export interface DailyTrade {
  tradeId: string;
  symbol: string;
  buyOrderId: string;
  sellOrderId: string;
  buyPrice: number;
  sellPrice: number;
  qty: number;
  grossPnl: number;
  charges: number;
  pnl: number;
  openedAt: number;
  closedAt: number;
  strategyId: string;
  mode: Order["mode"];
}

type FilledOrder = Order & { filledPrice: number; filledAt: number };

interface OpenLeg {
  order: FilledOrder;
  qty: number;
}

/** Pair today's filled orders FIFO by symbol and calculate net trade P&L. */
export function buildDailyTrades(orders: readonly Order[]): DailyTrade[] {
  const openBuys = new Map<string, OpenLeg[]>();
  const openSells = new Map<string, OpenLeg[]>();
  const trades: DailyTrade[] = [];
  const filled = orders
    .filter(
      (order): order is FilledOrder =>
        order.status === "FILLED" &&
        order.filledPrice !== undefined &&
        order.filledAt !== undefined,
    )
    .sort((left, right) => left.filledAt - right.filledAt);

  for (const order of filled) {
    const sameSide = order.side === "BUY" ? openBuys : openSells;
    const oppositeSide = order.side === "BUY" ? openSells : openBuys;
    const opposite = oppositeSide.get(order.symbol) ?? [];
    let remaining = order.qty;

    while (remaining > 0 && opposite.length > 0) {
      const leg = opposite[0];
      if (!leg) break;
      const qty = Math.min(remaining, leg.qty);
      const buy = order.side === "BUY" ? order : leg.order;
      const sell = order.side === "SELL" ? order : leg.order;
      const grossPnl = (sell.filledPrice - buy.filledPrice) * qty;
      const charges =
        ((buy.charges ?? 0) * qty) / buy.qty +
        ((sell.charges ?? 0) * qty) / sell.qty;

      trades.push({
        tradeId: `${buy.orderId}-${sell.orderId}-${trades.length}`,
        symbol: order.symbol,
        buyOrderId: buy.orderId,
        sellOrderId: sell.orderId,
        buyPrice: buy.filledPrice,
        sellPrice: sell.filledPrice,
        qty,
        grossPnl,
        charges,
        pnl: grossPnl - charges,
        openedAt: buy.filledAt,
        closedAt: sell.filledAt,
        strategyId: order.strategyId,
        mode: order.mode,
      });

      remaining -= qty;
      leg.qty -= qty;
      if (leg.qty === 0) opposite.shift();
    }

    if (remaining > 0) {
      const legs = sameSide.get(order.symbol) ?? [];
      legs.push({ order, qty: remaining });
      sameSide.set(order.symbol, legs);
    }
  }

  return trades.sort((left, right) => right.closedAt - left.closedAt);
}
