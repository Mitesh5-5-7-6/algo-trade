import type { EventName, EventPayload } from "@neelkanth/contracts";
import type { TradeMode } from "@neelkanth/core";
import type { Notifier, Severity } from "./notifier.js";

/**
 * The event catalogue (Phase 16, task 16.4; design §5.2): which bus events
 * the operator is told about, at what severity, in what words.
 *
 * CRITICAL — immediately, never coalesced: trading halted; the daily-loss
 * limit reached; the broker disconnected or its token lost while the market
 * is open; SYSTEM_ERROR.
 * WARNING — order rejections and bursts of risk blocks, coalesced per window;
 * feed silent; daily loss at 50 % and 80 % of the limit; trading resumed; a
 * disconnect or token loss outside the session.
 * INFO — as it happens: entry fills, positions closed with reason and P&L,
 * the market opening, recoveries.
 *
 * Everything here is a consumer of events that already exist. Nothing reads a
 * dashboard value, and nothing here can reach the order path (D2, D3).
 */

/** The slice of the event bus this needs. */
export interface CatalogueBus {
  subscribe<N extends EventName>(
    name: N,
    handler: (event: { name: N; payload: EventPayload<N> }) => void,
  ): Promise<void>;
}

export interface CatalogueDeps {
  readonly bus: CatalogueBus;
  readonly notifier: Notifier;
  readonly mode: TradeMode;
  /**
   * Whether INFO messages are sent. True, and they arrive without sound
   * (design §5.1 D9, decided in 16.1).
   */
  readonly includeInfo: boolean;
  /** The daily-loss limit in force now (runtime risk limits). */
  readonly dailyLossLimit: () => number;
  /** Whether the market is open now: decides CRITICAL vs WARNING for a disconnect. */
  readonly marketOpen: () => boolean;
  /** Coalescing window for rejections and risk-block bursts. Default 60 s. */
  readonly windowMs?: number;
  /** Risk blocks in one window before it counts as a burst. Default 5. */
  readonly riskBurst?: number;
  /** Test seam for the window timer. */
  readonly schedule?: (fn: () => void, ms: number) => void;
}

/** Loss levels warned about once a day, as fractions of the limit. */
const LOSS_WARNINGS = [0.5, 0.8] as const;

const inr = (value: number): string =>
  `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** P&L with its sign in front of the currency: -₹45.5, +₹120. */
const signedInr = (value: number): string =>
  `${value < 0 ? "-" : "+"}${inr(Math.abs(value))}`;

export async function subscribeCatalogue(deps: CatalogueDeps): Promise<void> {
  const windowMs = deps.windowMs ?? 60_000;
  const riskBurst = deps.riskBurst ?? 5;
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      setTimeout(fn, ms).unref();
    });

  const send = (severity: Severity, title: string, body?: string): void => {
    if (severity === "INFO" && !deps.includeInfo) return;
    deps.notifier.notify({
      severity,
      mode: deps.mode,
      title,
      ...(body === undefined ? {} : { body }),
    });
  };
  const inSession = (): Severity =>
    deps.marketOpen() ? "CRITICAL" : "WARNING";

  // --- Trading switch ---
  await deps.bus.subscribe("TRADING_HALTED", ({ payload }) => {
    send("CRITICAL", `Trading halted (${payload.source})`, payload.reason);
  });
  await deps.bus.subscribe("TRADING_RESUMED", () => {
    send("WARNING", "Trading resumed by the operator");
  });
  await deps.bus.subscribe("SYSTEM_ERROR", ({ payload }) => {
    // The message only: `context` can carry order and position identifiers,
    // which have no place in a chat (D5).
    send("CRITICAL", `System error — ${payload.source}`, payload.message);
  });

  // --- Broker and feed ---
  await deps.bus.subscribe("BROKER_DISCONNECTED", ({ payload }) => {
    send(inSession(), `Broker ${payload.broker} disconnected`, payload.reason);
  });
  await deps.bus.subscribe("BROKER_CONNECTED", ({ payload }) => {
    send("INFO", `Broker ${payload.broker} connected`);
  });
  await deps.bus.subscribe("BROKER_TOKEN_MISSING", ({ payload }) => {
    send(
      inSession(),
      `Broker ${payload.broker} token ${payload.reason === "expired" ? "expired" : "missing"}`,
      "Reconnect the broker from Settings — the feed and orders need a fresh token.",
    );
  });
  await deps.bus.subscribe("BROKER_TOKEN_RESTORED", ({ payload }) => {
    send("INFO", `Broker ${payload.broker} token restored`);
  });
  await deps.bus.subscribe("FEED_SILENT", ({ payload }) => {
    send(
      "WARNING",
      "Market feed silent",
      `${payload.silentSeconds === null ? "No tick since start-up" : `No tick for ${String(payload.silentSeconds)} s`}, ${String(payload.subscribed)} symbols subscribed, market open.`,
    );
  });
  await deps.bus.subscribe("FEED_RECOVERED", () => {
    send("INFO", "Market feed recovered");
  });

  // --- Orders and positions ---
  // An exit's reason rides on its fill; the P&L arrives with the position.
  // Remember the first to say both in one message.
  const exitReasons = new Map<string, string>();
  const positionKey = (strategyId: string, symbol: string) =>
    `${strategyId}|${symbol}`;

  await deps.bus.subscribe("ORDER_FILLED", ({ payload }) => {
    if (payload.exitReason !== undefined) {
      exitReasons.set(
        positionKey(payload.strategyId, payload.symbol),
        payload.exitReason,
      );
      return;
    }
    send(
      "INFO",
      `Entry filled: ${payload.side} ${String(payload.qty)} ${payload.symbol} @ ${String(payload.filledPrice)}`,
      `Strategy ${payload.strategyId}`,
    );
  });
  await deps.bus.subscribe("POSITION_UPDATED", ({ payload }) => {
    if (payload.status !== "CLOSED") return;
    const key = positionKey(payload.strategyId, payload.symbol);
    const reason = exitReasons.get(key);
    exitReasons.delete(key);
    send(
      "INFO",
      `Position closed: ${payload.symbol} ${signedInr(payload.realizedPnl)}`,
      `Strategy ${payload.strategyId}${reason === undefined ? "" : ` — ${reason}`}`,
    );
  });

  // Rejections: coalesced per window, so a broker refusing everything is one
  // message a minute rather than one per order.
  let rejections: EventPayload<"ORDER_REJECTED">[] = [];
  await deps.bus.subscribe("ORDER_REJECTED", ({ payload }) => {
    if (rejections.length === 0) {
      schedule(() => {
        const batch = rejections;
        rejections = [];
        const lines = batch
          .slice(0, 5)
          .map((r) => `${r.side} ${String(r.qty)} ${r.symbol}: ${r.reason}`);
        if (batch.length > 5)
          lines.push(`…and ${String(batch.length - 5)} more`);
        send(
          "WARNING",
          batch.length === 1
            ? "Order rejected by the broker"
            : `${String(batch.length)} orders rejected by the broker`,
          lines.join("\n"),
        );
      }, windowMs);
    }
    rejections.push(payload);
  });

  // Risk blocks are routine one at a time (a bearish market blocks a BUY);
  // only a burst says something is wrong.
  let blocks: EventPayload<"RISK_BLOCKED">[] = [];
  await deps.bus.subscribe("RISK_BLOCKED", ({ payload }) => {
    if (blocks.length === 0) {
      schedule(() => {
        const batch = blocks;
        blocks = [];
        if (batch.length < riskBurst) return;
        const byCheck = new Map<string, number>();
        for (const b of batch) {
          byCheck.set(b.failedCheck, (byCheck.get(b.failedCheck) ?? 0) + 1);
        }
        send(
          "WARNING",
          `${String(batch.length)} signals blocked by risk in ${String(Math.round(windowMs / 1000))} s`,
          [...byCheck]
            .map(([check, n]) => `${check} × ${String(n)}`)
            .join(", "),
        );
      }, windowMs);
    }
    blocks.push(payload);
  });

  // --- Daily loss, from the global P&L the runtime already publishes ---
  let warned = new Set<number>();
  let limitReached = false;
  await deps.bus.subscribe("MARKET_OPEN", () => {
    warned = new Set();
    limitReached = false;
    send("INFO", "Market open");
  });
  await deps.bus.subscribe("PNL_UPDATED", ({ payload }) => {
    if (payload.scope !== "global") return;
    const limit = deps.dailyLossLimit();
    const loss = Math.max(0, -payload.realizedPnl);
    if (limit <= 0 || loss === 0) return;
    if (loss >= limit) {
      if (limitReached) return;
      limitReached = true;
      send(
        "CRITICAL",
        "Daily loss limit reached",
        `Realised loss ${inr(loss)} of ${inr(limit)}. New entries are blocked; exits still run.`,
      );
      return;
    }
    for (const level of LOSS_WARNINGS) {
      if (loss >= limit * level && !warned.has(level)) {
        warned.add(level);
        send(
          "WARNING",
          `Daily loss at ${String(level * 100)}% of the limit`,
          `Realised loss ${inr(loss)} of ${inr(limit)}.`,
        );
      }
    }
  });
}
