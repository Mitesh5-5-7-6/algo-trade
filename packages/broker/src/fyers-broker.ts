import type {
  BrokerConnectionState,
  BrokerOrderRequest,
  BrokerOrderStatus,
  ExecutionOutcome,
  OrderStatus,
  OrderUpdate,
} from "@neelkanth/core";
import type { Broker } from "./broker.js";
import {
  fyersDataSocket,
  fyersOrderSocket,
  type FyersDataSocketInstance,
  type FyersOrderSocketInstance,
  type FyersOrderUpdate,
} from "fyers-api-v3";

export interface FyersBrokerDeps {
  appId: string;
  getToken: () => Promise<string | null>;
  /** Redis rate limiter or similar can be injected here */
  checkRateLimit?: () => Promise<void>;
}

/** Loose shape for FYERS API JSON responses. */
interface FyersResponse {
  s: string;
  message?: string;
  code?: number;
  id?: string;
  access_token?: string;
  refresh_token?: string;
  orderBook?: Array<{
    orderTag: string;
    id: string;
    status: number;
    /** Average traded price — present once the order has filled. */
    tradedPrice?: number;
    filledQty?: number;
    /** FYERS order timestamp, epoch SECONDS. */
    orderDateTime?: string;
    exchOrdId?: string;
  }>;
}

type ProtectiveLegs = {
  stopLoss?: number;
  takeProfit?: number;
  legType?: number;
};

/**
 * Convert our absolute stop/target into the point offsets FYERS wants.
 *
 * FAILS CLOSED. An order that asked for a stop and cannot express one is
 * refused, never downgraded to a bare entry: silently dropping the leg leaves
 * a live naked position that the strategy — and the risk engine's exposure
 * arithmetic — believe is protected. That is a worse outcome than not trading,
 * so the reason is returned and the order is rejected with it.
 *
 * An order that asked for nothing is fine and returns no legs.
 */
function toProtectiveLegs(
  order: BrokerOrderRequest,
): { ok: true; legs: ProtectiveLegs } | { ok: false; reason: string } {
  if (order.stopLoss === undefined && order.takeProfit === undefined) {
    return { ok: true, legs: {} };
  }

  // A LIMIT order's own price is an entry reference in its own right, so it
  // stands in when the caller supplied none. Only a MARKET order with neither
  // has nothing to measure from.
  const entry = order.referencePrice ?? order.price;
  if (entry === undefined) {
    return {
      ok: false,
      reason:
        "stop/target requested but no referencePrice to measure the offset " +
        "from — refusing to place an unprotected entry",
    };
  }

  const long = order.side === "BUY";
  // A stop sits below a long entry and above a short one; a target, the
  // reverse. Signed so an inverted level yields a negative offset and is
  // dropped, rather than being flipped by Math.abs into a plausible lie.
  const stopOffset =
    order.stopLoss === undefined
      ? undefined
      : long
        ? entry - order.stopLoss
        : order.stopLoss - entry;
  const targetOffset =
    order.takeProfit === undefined
      ? undefined
      : long
        ? order.takeProfit - entry
        : entry - order.takeProfit;

  if (stopOffset !== undefined && !(stopOffset > 0)) {
    return {
      ok: false,
      reason:
        `stop ${String(order.stopLoss)} is not on the protective side of ` +
        `entry ${String(entry)} for a ${order.side} — refusing`,
    };
  }
  if (targetOffset !== undefined && !(targetOffset > 0)) {
    return {
      ok: false,
      reason:
        `target ${String(order.takeProfit)} is not beyond entry ` +
        `${String(entry)} for a ${order.side} — refusing`,
    };
  }

  const legs: ProtectiveLegs = {
    ...(stopOffset === undefined ? {} : { stopLoss: round2(stopOffset) }),
    ...(targetOffset === undefined ? {} : { takeProfit: round2(targetOffset) }),
    // legType 1 = points (the default, sent explicitly so it cannot drift).
    legType: 1,
  };
  return { ok: true, legs };
}

/** FYERS rejects sub-paise precision on price fields. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * FYERS order status code → ours. 1 Cancelled, 2 Traded, 3 Transit,
 * 4 Rejected, 5 Pending, 6 Expired.
 *
 * Shared by the REST order book and the order socket deliberately: the SDK
 * normalizes the socket's raw codes into this same set, and two copies of this
 * table would eventually disagree about what "filled" means.
 */
function mapFyersStatus(code: number | undefined): OrderStatus {
  if (code === 2) return "FILLED";
  if (code === 4 || code === 6) return "REJECTED";
  if (code === 1) return "CANCELLED";
  return "PENDING";
}

/**
 * One order-socket row → an `OrderUpdate`, or null when it says nothing we act
 * on (a still-pending leg, or a row we cannot attribute).
 *
 * `orderTag` is our own `clientOrderId` and is the only link back to the order
 * row; a row without one is unattributable, so it is ignored rather than
 * guessed at.
 *
 * A FILLED row without a traded price is dropped for the same reason
 * `reconcile()` escalates one: publishing a fill at an invented price corrupts
 * the position's average entry and every P&L figure below it. Dropping leaves
 * the order PENDING, which `reconcile()` can still resolve against the order
 * book — a visible gap instead of a silent lie (plan/02 §10).
 */
function toOrderUpdate(row: FyersOrderUpdate): OrderUpdate | null {
  const clientOrderId = row.orderTag;
  if (typeof clientOrderId !== "string" || clientOrderId === "") return null;

  const status = mapFyersStatus(row.status);
  if (status === "PENDING") return null; // accepted, nothing traded yet

  if (status === "CANCELLED") return { status: "CANCELLED", clientOrderId };

  if (status === "REJECTED") {
    return {
      status: "REJECTED",
      clientOrderId,
      // The OMS message IS the diagnosis for an F&O refusal (lot size, margin,
      // product type). `reason` is non-empty by contract, so it gets a
      // truthful placeholder only when the broker genuinely sent none.
      reason:
        typeof row.message === "string" && row.message !== ""
          ? row.message
          : "rejected by broker (no reason supplied)",
    };
  }

  const filledPrice = row.tradedPrice;
  if (typeof filledPrice !== "number" || filledPrice <= 0) return null;
  const filledQty =
    typeof row.filledQty === "number" && row.filledQty > 0
      ? row.filledQty
      : typeof row.qty === "number" && row.qty > 0
        ? row.qty
        : undefined;
  if (filledQty === undefined) return null;

  return {
    status: "FILLED",
    fill: {
      clientOrderId,
      ...(typeof row.id === "string" && row.id !== ""
        ? { brokerOrderId: row.id }
        : {}),
      filledPrice,
      filledQty,
      // Not knowable from an order-book row. Zero rather than a fabricated
      // number — the same choice `reconcile()` makes, for the same reason.
      slippage: 0,
      charges: 0,
      filledAt: toEpochMs(row.orderDateTime),
    },
  };
}

/** FYERS timestamps are epoch SECONDS; anything unusable falls back to now. */
function toEpochMs(value: number | string | undefined): number {
  const seconds = typeof value === "string" ? Number(value) : value;
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return Date.now();
  }
  return seconds > 1e11 ? seconds : seconds * 1000;
}

/**
 * FyersBroker implements the Broker interface for the live FYERS environment
 * (plan/19).
 * - Execution: native fetch against the v3 REST API on api-t1.fyers.in.
 * - Market data: the vendor SDK, which speaks the HSM protobuf feed.
 *
 * The SDK import is contained here on purpose. It is the only third-party
 * broker client in the process, and the `Broker` port keeps it out of the
 * engines, strategies and risk layer entirely.
 */
export class FyersBroker implements Broker {
  private readonly deps: FyersBrokerDeps;
  /** The vendor SDK's feed client. Null until `connect` succeeds. */
  private socket: FyersDataSocketInstance | null = null;
  /** The order-update feed. Null until `connect` succeeds. */
  private orderSocket: FyersOrderSocketInstance | null = null;
  private connectionState: BrokerConnectionState = "disconnected";
  private readonly dataHandlers: ((raw: unknown) => void)[] = [];
  private readonly stateHandlers: ((state: BrokerConnectionState) => void)[] =
    [];
  private readonly orderUpdateHandlers: ((u: OrderUpdate) => void)[] = [];
  private subscribedSymbols: readonly string[] = [];

  constructor(deps: FyersBrokerDeps) {
    this.deps = deps;
  }

  // --- Execution (REST) ---

  async execute(order: BrokerOrderRequest): Promise<ExecutionOutcome> {
    if (this.deps.checkRateLimit) await this.deps.checkRateLimit();
    const token = await this.deps.getToken();
    if (!token)
      return {
        status: "REJECTED",
        clientOrderId: order.clientOrderId,
        reason: "No access token",
      };

    // Protective legs ride on an ordinary INTRADAY order (README "Orders with
    // TP/SL"), as OFFSETS in points from the entry — `legType: 1`.
    //
    // This replaces a BO/CO productType split that could never place an entry.
    // Both of those branches demanded a LIMIT price to subtract from, and the
    // Order Manager only ever builds MARKET orders, so every strategy entry —
    // all three attach a stop and a target — was refused here, locally, before
    // a request was made. Exits carry no legs and were the only orders that
    // could reach the network at all.
    //
    // The entry to measure from is `referencePrice`: the order's own limit if
    // it has one, otherwise the close the strategy computed the levels
    // against. Absent it, the legs are DROPPED rather than guessed — an
    // invented stop distance is a real position with the wrong risk on it.
    const legs = toProtectiveLegs(order);
    if (!legs.ok) {
      return {
        status: "REJECTED",
        clientOrderId: order.clientOrderId,
        reason: legs.reason,
      };
    }

    const payload = {
      symbol: order.symbol,
      qty: order.qty,
      type: order.type === "MARKET" ? 2 : 1, // 2: Market, 1: Limit
      side: order.side === "BUY" ? 1 : -1,
      productType: "INTRADAY",
      limitPrice: order.price ?? 0,
      stopPrice: 0,
      validity: "DAY",
      disclosedQty: 0,
      offlineOrder: false,
      ...legs.legs,
      orderTag: order.clientOrderId, // Crucial for reconciliation (plan/19 §5)
    };

    try {
      const headers = await this.getHeaders(token);
      const response = await fetch("https://api-t1.fyers.in/api/v3/orders/sync", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const data = (await response.json()) as FyersResponse;

      if (!response.ok || data.s !== "ok") {
        return {
          status: "REJECTED",
          clientOrderId: order.clientOrderId,
          reason: data.message || "Broker rejected order",
          code: data.code?.toString(),
        };
      }

      // Live orders are generally async, so we return PENDING.
      // Actual fill comes via WebSocket (onOrderUpdate).
      return {
        status: "PENDING",
        clientOrderId: order.clientOrderId,
        brokerOrderId: data.id || "unknown",
      };
    } catch (err: unknown) {
      return {
        status: "REJECTED",
        clientOrderId: order.clientOrderId,
        reason: (err as Error).message || "Network error",
      };
    }
  }

  async cancel(clientOrderId: string): Promise<void> {
    if (this.deps.checkRateLimit) await this.deps.checkRateLimit();

    // First, resolve the brokerOrderId if necessary via status(),
    // or FYERS might support canceling by orderTag/clientOrderId.
    // For now, we assume we can query status to get the brokerOrderId.
    const stat = await this.status(clientOrderId);
    if (!stat.found || !stat.brokerOrderId) {
      throw new Error("Cannot cancel: order not found at broker");
    }

    const token = await this.deps.getToken();
    if (!token) throw new Error("No access token");
    const headers = await this.getHeaders(token);
    const response = await fetch("https://api-t1.fyers.in/api/v3/orders/sync", {
      method: "DELETE",
      headers,
      body: JSON.stringify({ id: stat.brokerOrderId }),
    });

    const data = (await response.json()) as FyersResponse;
    if (!response.ok || data.s !== "ok") {
      throw new Error(data.message || "Cancel failed");
    }
  }

  async status(clientOrderId: string): Promise<BrokerOrderStatus> {
    if (this.deps.checkRateLimit) await this.deps.checkRateLimit();
    const token = await this.deps.getToken();
    if (!token) return { clientOrderId, found: false };

    const headers = await this.getHeaders(token);
    const response = await fetch("https://api-t1.fyers.in/api/v3/orders", {
      method: "GET",
      headers,
    });

    const data = (await response.json()) as FyersResponse;
    if (!response.ok || data.s !== "ok" || !data.orderBook) {
      return { clientOrderId, found: false };
    }

    const order = data.orderBook.find((o) => o.orderTag === clientOrderId);
    if (!order) {
      return { clientOrderId, found: false };
    }

    const internalStatus = mapFyersStatus(order.status);

    // Fill details ride along when the broker has them. Reconciliation after
    // a crash rebuilds Position and PnL from these; without a price it can
    // only escalate, because a guessed average entry corrupts every P&L
    // figure derived from it (plan/12 §8).
    const filledPrice =
      typeof order.tradedPrice === "number" && order.tradedPrice > 0
        ? order.tradedPrice
        : undefined;
    const filledQty =
      typeof order.filledQty === "number" && order.filledQty > 0
        ? order.filledQty
        : undefined;

    return {
      clientOrderId,
      found: true,
      status: internalStatus,
      brokerOrderId: order.id,
      ...(filledPrice === undefined ? {} : { filledPrice }),
      ...(filledQty === undefined ? {} : { filledQty }),
    };
  }

  onOrderUpdate(handler: (update: OrderUpdate) => void): void {
    this.orderUpdateHandlers.push(handler);
  }

  /**
   * Open the FYERS order-update socket (plan/19 §5).
   *
   * This is what makes a live order finish. `execute()` returns PENDING — the
   * exchange accepted it, nothing has traded — and the fill only ever arrives
   * here. Without this the handlers registered on `onOrderUpdate` were never
   * called by anything, so every live order stayed PENDING for good: no
   * ORDER_FILLED, no position, no PnL, against real money that had moved.
   *
   * Opened alongside the data feed and torn down with it, so one `connect()`
   * gives a caller both halves of the broker.
   */
  private connectOrderSocket(accessToken: string): void {
    if (this.orderSocket !== null) return;

    let socket: FyersOrderSocketInstance;
    try {
      socket = new fyersOrderSocket(`${this.deps.appId}:${accessToken}`, "", false);
    } catch {
      // A bad token throws while the SDK decodes it. The data socket reports
      // the same fault through the connection state; nothing to add here.
      return;
    }
    this.orderSocket = socket;

    socket.on("connect", () => {
      // Order updates only. Trades and positions are the broker's own
      // projections of the same fills — we derive ours from `orders` and
      // consuming both would double-count.
      socket.subscribe([socket.orderUpdates]);
    });

    socket.on("orders", (message) => {
      const update = toOrderUpdate(message.orders);
      if (update === null) return;
      for (const handler of this.orderUpdateHandlers) handler(update);
    });

    socket.on("close", () => {
      /* The SDK's autoreconnect owns recovery; state is the data feed's. */
    });
    socket.on("error", () => {
      /* Followed by close; not double-reported. */
    });

    socket.autoreconnect();
    socket.connect();
  }

  // --- Market Data (HSM feed, via the vendor SDK) ---

  /**
   * Open the FYERS market-data feed (plan/19 §4).
   *
   * The feed is the HSM protocol — protobuf frames over
   * `wss://socket.fyers.in/hsm/v1-5/prod` — so this delegates to the vendor's
   * own client rather than speaking it directly. The previous implementation
   * hand-rolled a JSON socket against `api.fyers.in`, a host that now answers
   * every v3 path with a 500; it could never have received a tick.
   *
   * The SDK is confined to this method and `subscribe`/`disconnect` below.
   * Everything upstream still sees only the `Broker` port.
   */
  async connect(): Promise<void> {
    if (this.connectionState === "connected") return;
    this.updateState("connecting");

    const accessToken = await this.deps.getToken();
    if (!accessToken) {
      // No token means the operator has not completed the FYERS OAuth round
      // trip. Stay disconnected and say so — the control plane reports this,
      // and a feed that silently never delivers is the failure we most need
      // to be visible (plan/06 §7).
      this.updateState("disconnected");
      return;
    }

    // `APPID:AccessToken` — the SDK decodes the token half as a JWT for its
    // expiry, so a stale or malformed token throws here rather than failing
    // later as an empty feed.
    let socket: FyersDataSocketInstance;
    try {
      socket = fyersDataSocket.getInstance(
        `${this.deps.appId}:${accessToken}`,
        "",
        false, // the SDK's own file logging; ours is structured (plan/23 §3)
      );
    } catch {
      this.updateState("disconnected");
      return;
    }

    this.socket = socket;

    socket.on("connect", () => {
      this.updateState("connected");
      // Subscriptions do not survive a reconnect (plan/17 §7), and the SDK
      // reconnects on its own — so re-establish them on every connect, not
      // just the first.
      if (this.subscribedSymbols.length > 0) {
        socket.subscribe(this.subscribedSymbols);
      }
    });

    socket.on("message", (message) => {
      // Forwarded untranslated; `fyersNormalizer` owns the shape (plan/04 §4).
      for (const handler of this.dataHandlers) handler(message);
    });

    socket.on("close", () => {
      this.updateState("disconnected");
    });

    socket.on("error", () => {
      // A socket error is followed by `close`, which owns the state change.
      // Swallowed here rather than double-reporting a single outage.
    });

    socket.connect();
    socket.autoreconnect();

    // The execution half. Opened here so one `connect()` yields a broker that
    // can both see the market and finish an order it places.
    this.connectOrderSocket(accessToken);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async disconnect(): Promise<void> {
    const orderSocket = this.orderSocket;
    this.orderSocket = null;
    if (orderSocket) orderSocket.close();

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      // Neither method is documented in the README, so both are optional in
      // our declaration and feature-checked rather than assumed.
      if (typeof socket.close === "function") socket.close();
      else if (typeof socket.disconnect === "function") socket.disconnect();
    }
    this.updateState("disconnected");
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async subscribe(symbols: readonly string[]): Promise<void> {
    // Remembered unconditionally: `connect` replays them, so subscribing
    // before the socket is up is valid and ordering-independent.
    this.subscribedSymbols = symbols;
    if (this.connectionState !== "connected" || this.socket === null) return;
    this.socket.subscribe(symbols);
  }

  onData(handler: (raw: unknown) => void): void {
    this.dataHandlers.push(handler);
  }

  onConnectionChange(handler: (state: BrokerConnectionState) => void): void {
    this.stateHandlers.push(handler);
  }

  // --- Internals ---

  private updateState(state: BrokerConnectionState) {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.stateHandlers.forEach(function (h) {
      h(state);
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async getHeaders(token: string) {
    return {
      "Content-Type": "application/json",
      Authorization: `${this.deps.appId}:${token}`,
    };
  }
}
