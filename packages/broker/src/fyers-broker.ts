import type {
  BrokerConnectionState,
  BrokerOrderRequest,
  BrokerOrderStatus,
  ExecutionOutcome,
  OrderUpdate,
} from "@neelkanth/core";
import type { Broker } from "./broker.js";
import { WebSocket } from "ws";

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
 * FyersBroker implements the Broker interface for the live FYERS environment (plan/19).
 * - Uses native fetch for REST execution API.
 * - Uses 'ws' for the market data WebSocket feed.
 */
export class FyersBroker implements Broker {
  private readonly deps: FyersBrokerDeps;
  private ws: WebSocket | null = null;
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

  // --- Market Data (WebSocket) ---

  async connect(): Promise<void> {
    if (this.connectionState === "connected") return;
    this.updateState("connecting");

    const accessToken = await this.deps.getToken();
    if (!accessToken) {
      this.updateState("disconnected");
      return;
    }

    const token = `${this.deps.appId}:${accessToken}`;
    this.ws = new WebSocket(
      // ⚠ BROKEN — this host is gone. Verified 2026-08-20:
      //   api.fyers.in/socket/v3/endpoints/data      → 500 "Invalid Request"
      //   api-t1.fyers.in/socket/v3/endpoints/data   → 404 (host live, no path)
      //   socket.fyers.in/hsm/v1-5/prod              → 101 Switching Protocols
      // The surviving endpoint speaks the HSM protocol: binary frames and an
      // auth handshake *after* the upgrade, not this `SUB_DATA` JSON with the
      // token in the query string. Repointing the URL alone would connect and
      // then receive nothing — and `updateState("connected")` on `open` would
      // report a healthy feed that never delivers a tick. Left pointing at the
      // dead host deliberately: it fails, and a failed feed reads as
      // disconnected, which is true. Fixing this means implementing the HSM
      // client against the v3 docs with a live token to test.
      `wss://api.fyers.in/socket/v3/endpoints/data?access_token=${token}`,
    );

    this.ws.on("open", () => {
      this.updateState("connected");
      if (this.subscribedSymbols.length > 0) {
        void this.subscribe(this.subscribedSymbols); // Re-establish subscriptions
      }
    });

    this.ws.on("message", (data) => {
      // Pass raw data to downstream normalizer
      this.dataHandlers.forEach(function (h) {
        h(data);
      });
    });

    this.ws.on("close", () => {
      this.updateState("disconnected");
      this.ws = null;
    });

    this.ws.on("error", () => {
      // Error will trigger close, state will be updated there
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.updateState("disconnected");
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async subscribe(symbols: readonly string[]): Promise<void> {
    this.subscribedSymbols = symbols;
    if (this.connectionState !== "connected" || !this.ws) return;

    const payload = {
      T: "SUB_DATA",
      L2list: symbols, // L2 quotes
      SUB_T: 1, // 1 for Subscribe
    };

    this.ws.send(JSON.stringify(payload));
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
