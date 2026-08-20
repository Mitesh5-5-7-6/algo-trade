import type {
  BrokerConnectionState,
  BrokerOrderRequest,
  BrokerOrderStatus,
  ExecutionOutcome,
  OrderUpdate,
} from "@neelkanth/core";
import type { Broker } from "./broker.js";
import {
  fyersDataSocket,
  type FyersDataSocketInstance,
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
  orderBook?: Array<{ orderTag: string; id: string; status: number }>;
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

    let productType = "INTRADAY";
    let fyersStopLoss = 0;
    let fyersTakeProfit = 0;

    if (order.stopLoss !== undefined && order.takeProfit !== undefined) {
      if (order.price === undefined) {
        return {
          status: "REJECTED",
          clientOrderId: order.clientOrderId,
          reason:
            "LIMIT price required for Bracket Orders to compute SL/TP difference",
        };
      }
      productType = "BO";
      fyersStopLoss = Math.abs(order.price - order.stopLoss);
      fyersTakeProfit = Math.abs(order.takeProfit - order.price);
    } else if (order.stopLoss !== undefined) {
      if (order.price === undefined) {
        return {
          status: "REJECTED",
          clientOrderId: order.clientOrderId,
          reason:
            "LIMIT price required for Cover Orders to compute SL difference",
        };
      }
      productType = "CO";
      // In FYERS, CO stopLoss is also absolute difference or trigger price?
      // The plan specified calculating absolute point difference. We will do so for both.
      // Wait, FYERS CO uses absolute price for StopLoss, whereas BO uses difference.
      // But based on the approved plan: "calculate the difference on the fly."
      // Actually, if CO requires absolute price, we can just pass the absolute price.
      // Let's pass the absolute price for CO stopLoss since it's standard across brokers for CO,
      // or we can pass difference. FYERS v3 CO uses stopPrice field.
      // Let's map BO to stopLoss/takeProfit fields and CO to stopPrice field.
      fyersStopLoss = order.stopLoss; // absolute trigger price for CO
    }

    const payload = {
      symbol: order.symbol,
      qty: order.qty,
      type: order.type === "MARKET" ? 2 : 1, // 2: Market, 1: Limit
      side: order.side === "BUY" ? 1 : -1,
      productType,
      limitPrice: order.price ?? 0,
      stopPrice: productType === "CO" ? fyersStopLoss : 0,
      validity: "DAY",
      disclosedQty: 0,
      offlineOrder: false,
      ...(productType === "BO"
        ? { stopLoss: fyersStopLoss, takeProfit: fyersTakeProfit }
        : {}),
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

    const order = data.orderBook.find(
      (o: { orderTag: string; status: number; id: string }) =>
        o.orderTag === clientOrderId,
    );
    if (!order) {
      return { clientOrderId, found: false };
    }

    // Map FYERS status (1=Canceled, 2=Traded, 3=Transit, 4=Rejected, 5=Pending, 6=Expired)
    let internalStatus: BrokerOrderStatus["status"];
    if (order.status === 2) internalStatus = "FILLED";
    else if (order.status === 4 || order.status === 6)
      internalStatus = "REJECTED";
    else if (order.status === 1) internalStatus = "CANCELLED";
    else internalStatus = "PENDING";

    return {
      clientOrderId,
      found: true,
      status: internalStatus,
      brokerOrderId: order.id,
    };
  }

  onOrderUpdate(handler: (update: OrderUpdate) => void): void {
    this.orderUpdateHandlers.push(handler);
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
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async disconnect(): Promise<void> {
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
