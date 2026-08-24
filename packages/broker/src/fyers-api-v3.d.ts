/**
 * Ambient types for `fyers-api-v3`, the vendor's own client. It ships no
 * typings, so this declares exactly the surface we use — nothing more.
 *
 * Why the SDK at all: the FYERS v3 market-data feed is the HSM protocol —
 * protobuf frames over `wss://socket.fyers.in/hsm/v1-5/prod`, implemented in
 * ~135KB of minified, partly obfuscated code. Reimplementing that by reading
 * the minified source would mean guessing at binary frame layouts in a process
 * that places trades, and the failure mode is silent: a socket that connects,
 * reports healthy, and decodes garbage. Using the vendor's maintained client
 * is the smaller risk.
 *
 * It stays behind `FyersBroker`. Nothing above the broker layer imports it,
 * so replacing it later is a change to one file.
 *
 * Shapes are taken from the package README and `sample/datasocket.js`. Methods
 * whose presence we cannot verify without a live token are optional here and
 * feature-checked at the call site.
 */
declare module "fyers-api-v3" {
  /** Emitted tick. Field names come from the SDK's own `HSM/mapper.js`. */
  export interface FyersDataMessage {
    symbol?: string;
    type?: string;
    ltp?: number;
    vol_traded_today?: number;
    exch_feed_time?: number;
    last_traded_time?: number;
    bid_price?: number;
    ask_price?: number;
    [key: string]: unknown;
  }

  export interface FyersDataSocketInstance {
    on(event: "connect" | "close", handler: () => void): void;
    on(event: "message", handler: (message: FyersDataMessage) => void): void;
    on(event: "error", handler: (error: unknown) => void): void;

    /** Opens the socket. Non-blocking — completion arrives as `connect`. */
    connect(): void;
    /** Enables the SDK's own reconnect loop. */
    autoreconnect(retries?: number): void;
    /** `depth` requests market depth, which arrives as a separate tick. */
    subscribe(symbols: readonly string[], depth?: boolean): void;
    unsubscribe(symbols: readonly string[], depth?: boolean): void;

    /** Present in the shipped build, but not documented in the README. */
    isConnected?(): boolean;
    close?(): void;
    disconnect?(): void;
    mode?(mode: unknown): void;
    readonly FullMode?: unknown;
    readonly LiteMode?: unknown;
  }

  /**
   * One order-book row as the order socket delivers it, after the SDK's own
   * `ordersocket/mapper.js` renames the wire fields. `status` has already been
   * translated by the SDK into the same 1–6 codes the REST order book uses
   * (1 Cancelled, 2 Traded, 3 Transit, 4 Rejected, 5 Pending, 6 Expired).
   */
  export interface FyersOrderUpdate {
    orderTag?: string;
    id?: string;
    status?: number;
    tradedPrice?: number;
    filledQty?: number;
    qty?: number;
    /** The OMS's own message — the rejection reason, when it rejects. */
    message?: string;
    /** Epoch SECONDS. */
    orderDateTime?: number | string;
    [key: string]: unknown;
  }

  export interface FyersOrderSocketInstance {
    on(event: "connect" | "close", handler: () => void): void;
    on(event: "error" | "general", handler: (message: unknown) => void): void;
    on(
      event: "orders",
      handler: (message: { s: string; orders: FyersOrderUpdate }) => void,
    ): void;

    connect(): void;
    autoreconnect(retries?: number): void;
    /** Channel names to subscribe; use the instance's own channel constants. */
    subscribe(channels: readonly string[]): void;
    unsubscribe(channels: readonly string[]): void;
    close(): void;

    /** Channel-name constants exposed on the instance. */
    readonly orderUpdates: string;
    readonly tradeUpdates: string;
    readonly positionUpdates: string;
    isConnected?(): boolean;
  }

  /**
   * The order-update socket. Constructed with the SAME `"APPID:AccessToken"`
   * authorization string as the data socket, but it is a `new`-able class
   * rather than a getInstance singleton.
   */
  export const fyersOrderSocket: new (
    authorizationKey: string,
    logPath?: string,
    enableLogging?: boolean,
  ) => FyersOrderSocketInstance;

  export const fyersDataSocket: {
    /**
     * @param accessToken `"APPID:AccessToken"` — the app id and the access
     *   token joined by a colon, per the README. The SDK decodes the token as
     *   a JWT to read its expiry, so a malformed one throws here.
     * @param logPath where the SDK writes its own logs
     * @param enableLogging keep false; our logging is structured (plan/23 §3)
     */
    getInstance(
      accessToken: string,
      logPath?: string,
      enableLogging?: boolean,
    ): FyersDataSocketInstance;
  };
}
