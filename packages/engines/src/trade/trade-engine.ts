import { applyTradeFill, type Trade, type TradeFill } from "@neelkanth/core";
import type { EventPayload } from "@neelkanth/contracts";
import type { TradePorts } from "./ports.js";

export interface TradeEngineDeps {
  ports: TradePorts;
  /** Injected so ids are deterministic under replay (plan/27 §4). */
  nextTradeId: () => string;
  /** Required error sink — no silent failures (plan/02 §10). */
  onError: (error: unknown, context: Record<string, unknown>) => void;
}

/**
 * The Trade Engine: turns fills into completed trades (ADR §9.2).
 *
 * A projection over `ORDER_FILLED`, running alongside the Position Engine and
 * keyed the same way — `(strategyId, symbol)` — so the two never disagree
 * about which position a fill belongs to. They answer different questions:
 * the position says what is held *now*; the trade says what one decision
 * *earned*, which is the only thing research can label an outcome with.
 *
 * Idempotent on `orderId`. The event bus does not await its handlers and a
 * broker can repeat an update, so a redelivered fill must change nothing. This
 * is the same guard the Position Engine keeps, for the same reason.
 *
 * Never throws into the bus: a failure here must not stop the position
 * projection or the PnL that follows it. Losing a trade record is bad; losing
 * the system's view of what it is holding is worse.
 */
export class TradeEngine {
  private readonly ports: TradePorts;
  private readonly nextTradeId: () => string;
  private readonly onError: TradeEngineDeps["onError"];
  /** Open trade per `(strategyId, symbol)` — the hot lookup. */
  private readonly open = new Map<string, Trade>();
  /** Fills already folded in, so a redelivery is a no-op. */
  private readonly applied = new Set<string>();

  constructor(deps: TradeEngineDeps) {
    this.ports = deps.ports;
    this.nextTradeId = deps.nextTradeId;
    this.onError = deps.onError;
  }

  private static key(strategyId: string, symbol: string): string {
    return `${strategyId}|${symbol}`;
  }

  /**
   * Restore open trades after a restart.
   *
   * Without this a restart mid-position would open a SECOND trade on the next
   * fill and leave the first open forever — one position recorded as two
   * trades, neither of them true.
   */
  async hydrate(): Promise<void> {
    try {
      for (const trade of await this.ports.loadOpenTrades()) {
        this.open.set(TradeEngine.key(trade.strategyId, trade.symbol), trade);
      }
    } catch (error) {
      this.onError(error, { where: "hydrate" });
    }
  }

  /** The open trade for a strategy and symbol, or null. */
  getOpen(strategyId: string, symbol: string): Trade | null {
    return this.open.get(TradeEngine.key(strategyId, symbol)) ?? null;
  }

  async onOrderFilled(payload: EventPayload<"ORDER_FILLED">): Promise<void> {
    try {
      if (this.applied.has(payload.orderId)) return;
      this.applied.add(payload.orderId);

      const key = TradeEngine.key(payload.strategyId, payload.symbol);
      let fill: TradeFill | null = {
        orderId: payload.orderId,
        side: payload.side,
        qty: payload.qty,
        price: payload.filledPrice,
        charges: payload.charges,
        // Kept rather than discarded. The Position Engine drops this, which is
        // why execution quality has never been measurable (CURRENT_STATE §3.5).
        slippage: payload.slippage,
        filledAt: payload.filledAt,
      };

      // A reversal produces a remainder that opens a new trade; the loop is
      // bounded because each pass strictly reduces the outstanding quantity.
      while (fill !== null) {
        const current = this.open.get(key) ?? null;
        const result = applyTradeFill(current, fill, {
          tradeId:
            current?.status === "OPEN" ? current.tradeId : this.nextTradeId(),
          strategyId: payload.strategyId,
          symbol: payload.symbol,
          mode: payload.mode,
        });

        if (result.trade.status === "CLOSED") {
          this.open.delete(key);
        } else {
          this.open.set(key, result.trade);
        }
        await this.ports.saveTrade(result.trade);
        fill = result.remainder;
      }
    } catch (error) {
      this.onError(error, {
        where: "onOrderFilled",
        orderId: payload.orderId,
        symbol: payload.symbol,
      });
    }
  }
}
