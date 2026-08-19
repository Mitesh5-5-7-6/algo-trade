/**
 * FYERS webhook payload normalization (plan/04 §4: validate at the boundary).
 *
 * A broker callback is the one input we do not control the shape of: FYERS
 * changes fields without notice, wraps order updates in different envelopes
 * across their REST postback and socket-mirrored forms, and sends `null`
 * where the docs promise a number. So this module is deliberately *tolerant*
 * where the codebase is normally strict: the only hard requirement is "the
 * body is a JSON object". Everything past that is best-effort extraction.
 *
 * The rule that keeps that safe: normalization is ADDITIVE, never lossy. The
 * untouched broker payload always rides along in `raw`, so a field we failed
 * to recognize today is still recoverable from the inbox tomorrow. Nothing
 * here decides anything about money — it shapes an event for the pipeline to
 * consume, and an unrecognized shape becomes `kind: "unknown"` rather than a
 * rejected delivery (a webhook that 400s on a new field is an outage).
 */

/** What the callback is telling us about. */
export type FyersWebhookKind =
  | "order"
  | "trade"
  | "position"
  | "ping"
  | "unknown";

/** Normalized order state. `unknown` is honest, not a default. */
export type FyersOrderStatus =
  | "pending"
  | "transit"
  | "filled"
  | "cancelled"
  | "rejected"
  | "expired"
  | "unknown";

export interface FyersWebhookEvent {
  readonly source: "fyers";
  readonly kind: FyersWebhookKind;
  /** Server clock at ingest — the broker's own timestamp stays in `raw`. */
  readonly receivedAt: number;
  readonly brokerOrderId?: string | undefined;
  readonly exchangeOrderId?: string | undefined;
  readonly symbol?: string | undefined;
  readonly side?: "BUY" | "SELL" | undefined;
  readonly status?: FyersOrderStatus | undefined;
  readonly qty?: number | undefined;
  readonly filledQty?: number | undefined;
  readonly price?: number | undefined;
  readonly message?: string | undefined;
  /** The untouched broker payload. Never dropped, never rewritten. */
  readonly raw: unknown;
}

/**
 * FYERS encodes side numerically on order updates: 1 = buy, -1 = sell.
 * Anything else is left undefined rather than guessed — a wrong side is a
 * wrong trade.
 */
const SIDE_CODES = new Map<string, "BUY" | "SELL">([
  ["1", "BUY"],
  ["-1", "SELL"],
  ["BUY", "BUY"],
  ["SELL", "SELL"],
]);

/** FYERS order status codes. 3 is reserved by the broker and unused today. */
const STATUS_CODES = new Map<string, FyersOrderStatus>([
  ["1", "cancelled"],
  ["2", "filled"],
  ["4", "transit"],
  ["5", "rejected"],
  ["6", "pending"],
  ["7", "expired"],
]);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `Array.isArray` narrows `unknown` to `any[]`, which would leak an implicit
 * `any` into every element read. This guard lands on `readonly unknown[]`
 * instead, so indexing stays typed (plan/25 §2: `any` is banned, absolutely).
 */
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** First present, non-null value among `keys`. */
function pick(source: JsonObject, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Numeric coercion that refuses NaN/Infinity — a bad number is no number. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Peel the FYERS envelope. Order updates arrive as the bare object, under
 * `d`/`data`, or one level deeper under `orders`/`order`/`trades`/`positions`.
 * We unwrap at most twice, and only into objects — an array payload (a batch)
 * keeps its first element as the subject while `raw` retains all of it.
 */
function unwrap(payload: JsonObject): JsonObject {
  let current = payload;
  for (let depth = 0; depth < 2; depth += 1) {
    const inner = pick(current, [
      "d",
      "data",
      "orders",
      "order",
      "trades",
      "positions",
    ]);
    const candidate = isArray(inner) ? inner[0] : inner;
    if (!isObject(candidate)) break;
    current = candidate;
  }
  return current;
}

/**
 * Classify the callback. Order first: FYERS sends order updates with the
 * position/trade fields absent, and an order id is the strongest signal we
 * have. A body with nothing recognizable in it is a `ping` — that is what the
 * broker's "is this URL alive?" probe looks like, and it must not be treated
 * as a lost event.
 */
function classify(envelope: JsonObject, subject: JsonObject): FyersWebhookKind {
  if (pick(subject, ["netQty", "netAvg", "buyQty", "sellQty"]) !== undefined) {
    return "position";
  }
  if (
    pick(envelope, ["trades"]) !== undefined ||
    pick(subject, ["tradeNumber", "tradeValue", "tradePrice"]) !== undefined
  ) {
    return "trade";
  }
  if (
    pick(subject, [
      "id",
      "orderNumber",
      "exchOrdId",
      "status",
      "orderStatus",
      "orderDateTime",
    ]) !== undefined
  ) {
    return "order";
  }
  // An empty body, or `{"s":"ok"}` with nothing else, is a liveness probe.
  const meaningful = Object.keys(envelope).filter(
    (key) => !["s", "code", "message", "ok"].includes(key),
  );
  return meaningful.length === 0 ? "ping" : "unknown";
}

/**
 * Normalize a decoded JSON body into a `FyersWebhookEvent`.
 *
 * `receivedAt` is injected rather than read from the clock so callers stay
 * deterministic in tests (plan/25: time is a dependency, not an ambient).
 * A non-object body (a bare string, an array, `null`) is still accepted — it
 * becomes `kind: "unknown"` carrying the original in `raw`, because dropping
 * a delivery we cannot parse loses information we may need later.
 */
export function normalizeFyersWebhook(
  body: unknown,
  receivedAt: number,
): FyersWebhookEvent {
  if (!isObject(body)) {
    const kind: FyersWebhookKind =
      body === undefined || body === null || body === "" ? "ping" : "unknown";
    return { source: "fyers", kind, receivedAt, raw: body ?? null };
  }

  const subject = unwrap(body);
  const kind = classify(body, subject);

  return {
    source: "fyers",
    kind,
    receivedAt,
    brokerOrderId: asString(pick(subject, ["id", "orderNumber", "order_id"])),
    exchangeOrderId: asString(pick(subject, ["exchOrdId", "exchangeOrderNo"])),
    symbol: asString(pick(subject, ["symbol", "tradingSymbol", "fyToken"])),
    side: SIDE_CODES.get(String(pick(subject, ["side", "transactionType"]))),
    status: STATUS_CODES.get(String(pick(subject, ["status", "orderStatus"]))),
    qty: asNumber(pick(subject, ["qty", "quantity", "orderQty"])),
    filledQty: asNumber(pick(subject, ["filledQty", "filled_qty", "tradedQty"])),
    price: asNumber(
      pick(subject, ["tradedPrice", "tradePrice", "limitPrice", "price"]),
    ),
    message: asString(pick(body, ["message"]) ?? pick(subject, ["message"])),
    raw: body,
  };
}
