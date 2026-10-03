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
 * Idempotent on `orderId`, in memory AND across a restart. The event bus
 * does not await its handlers and a broker can repeat an update, so a
 * redelivered fill must change nothing — including one that arrives after the
 * process came back, when the in-memory guard is empty and a repeated CLOSING
 * fill would otherwise look like a fresh opening fill on the other side.
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
  /** The last fill queued; the next one starts only when it has finished. */
  private tail: Promise<void> = Promise.resolve();

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
        // Pre-seed the guard. Not needed for correctness — the durable
        // lookup below would catch a redelivery anyway — but it saves that
        // read, and redeliveries cluster right after a restart. Every leg,
        // not just the entry and latest exit (L1); the two named fields
        // still count for a trade written before `orderIds` existed.
        for (const orderId of trade.orderIds) this.applied.add(orderId);
        this.applied.add(trade.entryOrderId);
        if (trade.exitOrderId !== undefined)
          this.applied.add(trade.exitOrderId);
      }
    } catch (error) {
      this.onError(error, { where: "hydrate" });
    }
  }

  /** The open trade for a strategy and symbol, or null. */
  getOpen(strategyId: string, symbol: string): Trade | null {
    return this.open.get(TradeEngine.key(strategyId, symbol)) ?? null;
  }

  /**
   * Fold one fill in — one at a time, in the order delivered (§2.7).
   *
   * The bus does not await its handlers, so fills can arrive while an earlier
   * one is still being applied, and applying awaits a durable lookup first.
   * Run concurrently, whichever lookup returned first applied first: a BUY
   * then SELL round trip was recorded as a SHORT entered on the SELL, and one
   * fill delivered twice at once slipped past the in-memory guard twice.
   * Never rejects, so one failed fill cannot stall the queue behind it.
   */
  onOrderFilled(payload: EventPayload<"ORDER_FILLED">): Promise<void> {
    const run = this.tail.then(() => this.apply(payload));
    this.tail = run;
    return run;
  }

  private async apply(payload: EventPayload<"ORDER_FILLED">): Promise<void> {
    try {
      if (this.applied.has(payload.orderId)) return;
      // Memory does not know it — but a previous lifetime might have. One
      // indexed read, and only for a fill this process has not seen.
      if ((await this.ports.findTradeByOrderId(payload.orderId)) !== null) {
        this.applied.add(payload.orderId);
        return;
      }
      this.applied.add(payload.orderId);

      const key = TradeEngine.key(payload.strategyId, payload.symbol);
      let fill: TradeFill | null = {
        orderId: payload.orderId,
        // Becomes `entrySignalId` / `exitSignalId` (§2.5, L4).
        ...(payload.signalId === undefined
          ? {}
          : { signalId: payload.signalId }),
        side: payload.side,
        qty: payload.qty,
        price: payload.filledPrice,
        charges: payload.charges,
        // Kept rather than discarded. The Position Engine drops this, which is
        // why execution quality has never been measurable (CURRENT_STATE §3.5).
        slippage: payload.slippage,
        filledAt: payload.filledAt,
        // Recorded, never inferred (D6). Absent when whoever closed the
        // position did not say why — which is a fact about the close, not a
        // gap to fill with a plausible guess.
        ...(payload.exitReason === undefined
          ? {}
          : { exitReason: payload.exitReason }),
      };

      // A reversal produces a remainder that opens a new trade; the loop is
      // bounded because each pass strictly reduces the outstanding quantity.
      while (fill !== null) {
        const current = this.open.get(key) ?? null;
        const positionId = this.ports.resolvePositionId(
          payload.strategyId,
          payload.symbol,
        );
        const result = applyTradeFill(current, fill, {
          tradeId:
            current?.status === "OPEN" ? current.tradeId : this.nextTradeId(),
          strategyId: payload.strategyId,
          symbol: payload.symbol,
          mode: payload.mode,
          ...(positionId === null ? {} : { positionId }),
          ...(payload.strategyVersion === undefined
            ? {}
            : { strategyVersion: payload.strategyVersion }),
          // Used only when this pass OPENS a trade — including a reversal's
          // remainder, whose entry decision is this very order (§2.1).
          ...(payload.dataProvenance === undefined
            ? {}
            : { dataProvenance: payload.dataProvenance }),
          ...(payload.marketContext === undefined
            ? {}
            : { marketContext: payload.marketContext }),
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
