# 09 — Event-Driven System

> Prerequisites: **[02_MASTER_ARCHITECTURE.md](02_MASTER_ARCHITECTURE.md)** §6–8 (the two communication regimes and state ownership) and **[08_REDIS_ARCHITECTURE.md](08_REDIS_ARCHITECTURE.md)** §3 (the `events:` Pub/Sub channels).
>
> **This chapter is the single source of truth for events.** Chapters 02, 05, 06, and 08 reference event names; those names are *defined* here. If an event name appears elsewhere, it must match this catalog.

---

## 1. Purpose

To document every event the system emits: its producer, its consumers, when it fires, its payload, its retry behavior, and how it's logged. Events are how components learn that a fact occurred without being coupled to whoever caused it.

---

## 2. What events are — and are not

Events carry **facts that already happened** ("a candle closed," "an order filled") to any interested consumer. They are the observability-and-projection layer (Chapter 02 §6, Regime B).

The single most important boundary, repeated because it's easy to get wrong: **events do NOT drive the money-critical decision path.** A `SIGNAL_CREATED` event is emitted for the dashboard and the audit log, but the signal reaches the Risk Engine through a **synchronous in-process call**, not by the Risk Engine subscribing to the event (Chapter 02 §6, Regime A). If you ever find yourself wiring the risk check or order placement as an *event subscriber*, stop — that reopens the duplicate-order race the synchronous path exists to close. Events announce; they never authorize execution.

---

## 3. Event envelope & conventions

Every event shares a common envelope, with its typed payload defined in the **`contracts` package** (Chapter 03) so the server and dashboard agree on its exact shape:

```
{
  name: "ORDER_FILLED",          // one of the catalog names below
  ts: 1730000000000,             // when the fact occurred
  correlationId: "sig_...",      // ties related events across the pipeline
  payload: { ... }               // event-specific, Zod-typed in `contracts`
}
```

- **Transport:** Redis Pub/Sub on channel `events:{NAME}` (Chapter 08 §3), except market data which uses `market:tick:{symbol}` / `market:candle:{symbol}:{interval}`.
- **`correlationId`** threads a decision through its lifecycle — a signal id can be carried on the resulting `ORDER_PLACED`, `ORDER_FILLED`, and `POSITION_UPDATED`, so an operator can trace one decision end-to-end. **Why:** determinism (Chapter 02, Principle 1) is only auditable if you can follow one decision across every fact it produced.
- **Typed payloads in `contracts`:** the single source of truth for event shape, so a producer and a consumer can never disagree about a field.

---

## 4. Retry model (read before the catalog)

"Retry behavior" means different things depending on the mechanism, and pretending every event is retried would be wrong. There are **three** distinct cases:

1. **Broadcast events (Pub/Sub) are NOT retried.** Pub/Sub is fire-and-forget (Chapter 08 §3). A consumer that was down misses the message. Recovery is by **resync**, not redelivery: the durable fact lives in Mongo (Chapter 07), so the dashboard refetches a snapshot on reconnect (Chapter 06 §7), and hot state rebuilds from the next ticks. This is acceptable precisely because no *decision* rides on Pub/Sub.
2. **Durable side-effects use BullMQ, which DOES retry.** When an event must trigger work that cannot be lost (send a notification, refresh a token, run an AI summary), the handler enqueues a **job** (Chapter 08 §6) with retry/backoff — the retry lives in the queue, not the event.
3. **Connection-level retries are separate.** `BROKER_DISCONNECTED` triggers a reconnect loop with backoff (Chapter 19); that's the connection retrying, distinct from event delivery.

So in each catalog entry, "Retry" states which of these applies.

---

## 5. Idempotency & ordering

Because recovery is by resync (§4), a consumer may occasionally **reprocess** an event (e.g., a fill it already applied). Consumers that mutate state must therefore be **idempotent**: the Position Engine keys off `orderId` so applying the same `ORDER_FILLED` twice yields the same position, not a doubled one. **Why this is mandatory, not optional:** without idempotency, a reconnect/resync could double-count a fill and corrupt PnL — turning a recovery mechanism into a data-integrity bug. Do not assume exactly-once delivery; design for at-least-once and make the effect idempotent.

---

## 6. The event catalog

Each entry: **Producer · Consumers · Trigger · Payload · Retry · Logging.** ("Consumers" lists *event* subscribers only; synchronous in-process handoffs are noted where relevant.)

### `MARKET_TICK`
- **Producer:** Market Data Engine.
- **Consumers:** Indicator Engine; dashboard streamer (throttled); metrics.
- **Trigger:** each normalized tick from the broker feed.
- **Payload:** `{ symbol, ltp, volume, bid, ask, ts }`.
- **Retry:** none (case 1); a missed tick is superseded by the next.
- **Logging:** **not** persisted per-tick to Mongo (firehose — sampled/TTL only, Chapter 07 `market_ticks`); counters/metrics only. Logging every tick synchronously would defeat the real-time path.

### `CANDLE_CLOSED`
- **Producer:** Market Data Engine (candle aggregator).
- **Consumers:** Indicator Engine (recompute); Strategy Engine (the primary heartbeat that triggers analysis); candle persister.
- **Trigger:** an interval boundary passes (1m/5m/…).
- **Payload:** `{ symbol, interval, open, high, low, close, volume, ts }`.
- **Retry:** none (case 1); the durable bar is in Mongo.
- **Logging:** persisted to `candles` (Chapter 07). **Why it's central:** most strategies analyze on candle close, not every tick — this event is the pipeline's clock.

### `INDICATORS_UPDATED`
- **Producer:** Indicator Engine.
- **Consumers:** Market Context Builder / Strategy Engine; dashboard indicator displays.
- **Trigger:** after recomputing indicators for a new candle.
- **Payload:** `{ symbol, interval, indicators: { ema, rsi, vwap, ... }, ts }`.
- **Retry:** none (case 1); latest values in `hot:indicators:*` are the source of truth (Chapter 08 §5).
- **Logging:** not persisted (recomputable); metrics only.

### `SIGNAL_CREATED`
- **Producer:** Strategy Engine.
- **Consumers:** dashboard; signal logger. **Note:** the Risk Engine receives the signal by **synchronous call**, not via this event (§2).
- **Trigger:** a strategy emits an actionable signal (BUY/SELL; HOLD is recorded but need not be broadcast widely).
- **Payload:** `{ signalId, strategyId, symbol, side, confidence, contextSnapshot, ts }`.
- **Retry:** none (case 1); persisted durable in Mongo.
- **Logging:** persisted to `signals` (Chapter 07) — the decision log.

### `RISK_BLOCKED`
- **Producer:** Risk Engine.
- **Consumers:** dashboard (show the block); risk logger; notifications (if severe, e.g., daily-loss limit hit).
- **Trigger:** a signal fails a risk check (duplicate, daily loss, position size, session).
- **Payload:** `{ signalId, strategyId, symbol, failedCheck, reason, ts }`.
- **Retry:** none (case 1).
- **Logging:** persisted to `risk_logs` (Chapter 07). **Why only blocks are broadcast:** `risk_logs` records both approvals and blocks, but a *block* is the exceptional, operator-relevant fact; an approval's observable consequence is the resulting `ORDER_PLACED`, so no separate approval event is emitted.

### `ORDER_PLACED`
- **Producer:** Order Manager.
- **Consumers:** dashboard (order appears); order logger.
- **Trigger:** the Order Manager submits an order to the broker (after synchronous risk approval).
- **Payload:** `{ orderId, signalId, strategyId, symbol, side, qty, type, price, mode, ts }`.
- **Retry:** the *event* isn't retried (case 1). The broker *submission* has its own semantics (Chapter 12/19) — don't conflate them.
- **Logging:** persisted to `orders` with status `PLACED` (Chapter 07).

### `ORDER_FILLED`
- **Producer:** Order Manager (on broker fill confirmation).
- **Consumers:** **Position Engine** (this is the trigger that starts the Regime B projection chain); dashboard; order logger.
- **Trigger:** the broker confirms a fill.
- **Payload:** `{ orderId, symbol, side, qty, filledPrice, slippage, charges, filledAt, mode, ts }`.
- **Retry:** none (case 1) — but the Position Engine's handling **must be idempotent by `orderId`** (§5), because a resync could redeliver it.
- **Logging:** updates `orders` to `FILLED` (Chapter 07). **The pivotal fact:** everything downstream (position, portfolio, PnL, dashboard) is a projection of this event (Chapter 02 §6).

### `POSITION_UPDATED`
- **Producer:** Position Engine.
- **Consumers:** Portfolio Engine; PnL Engine; dashboard.
- **Trigger:** a fill opens, increases, reduces, or closes a position.
- **Payload:** `{ symbol, strategyId, side, qty, avgEntryPrice, status, realizedPnl, ts }`.
- **Retry:** none (case 1); durable in `positions`.
- **Logging:** persisted to `positions` (Chapter 07).

### `PNL_UPDATED`
- **Producer:** PnL Engine.
- **Consumers:** dashboard (PnL panels/charts); **Risk Engine** (realized-loss changes update the `risk:` daily-loss counter, Chapter 08 §5, Chapter 14).
- **Trigger:** a position change (realized) or a price move (unrealized — throttled for the dashboard, since unrealized PnL changes with every tick).
- **Payload:** `{ scope, realizedPnl, unrealizedPnl, ts }` where `scope` is symbol/strategy/global.
- **Retry:** none (case 1).
- **Logging:** derived; realized values are held in `positions`, not separately persisted. **Why the Risk Engine listens:** this is how the daily-loss limit stays current, closing the loop between outcomes and the pre-trade gate.

### `BROKER_CONNECTED`
- **Producer:** Broker layer / Market Data Engine.
- **Consumers:** system status; dashboard; pipeline (resume normal operation); notifications.
- **Trigger:** the broker WebSocket/API connection is established or re-established.
- **Payload:** `{ broker, mode, ts }`.
- **Retry:** n/a (status report).
- **Logging:** `trade_logs`/system log; a notification on reconnect so the operator knows the feed is back.

### `BROKER_DISCONNECTED`
- **Producer:** Broker layer.
- **Consumers:** **Order Manager (halts new order placement — critical)**; dashboard (prominent); notifications; reconnect logic.
- **Trigger:** the broker connection is lost.
- **Payload:** `{ broker, mode, reason, ts }`.
- **Retry:** connection-level reconnect with backoff (case 3).
- **Logging:** system log + **severe notification**. **Why it matters most:** this event drives safe degradation (Chapter 02 §10) — the system must stop trading against a broker it can't confirm rather than fire orders blind.

### `MARKET_OPEN`
- **Producer:** session manager (within the Market Data Engine).
- **Consumers:** Strategy Engine (begin/resume analysis); dashboard; sets `hot:session` (Chapter 08 §5).
- **Trigger:** the exchange session opens (e.g., 09:15 IST for NSE).
- **Payload:** `{ exchange, session, ts }`.
- **Retry:** n/a.
- **Logging:** system log. **Why:** strategies must only act during valid sessions; this gates activity and pairs with the Risk Engine's session check (Chapter 14).

### `MARKET_CLOSE`
- **Producer:** session manager.
- **Consumers:** Strategy Engine (stop new entries; trigger any square-off logic); Position Engine (end-of-day marking/reconciliation); dashboard.
- **Trigger:** the exchange session closes (e.g., 15:30 IST).
- **Payload:** `{ exchange, session, ts }`.
- **Retry:** n/a.
- **Logging:** system log; may kick off EOD reconciliation.

### `SYSTEM_ERROR`
- **Producer:** any component (via the central error handler / logger, Chapter 05 §5).
- **Consumers:** monitoring (Chapter 23); dashboard (surface); notifications (if severe).
- **Trigger:** an unexpected error anywhere in the system.
- **Payload:** `{ source, level, message, context, ts }`.
- **Retry:** n/a (a report of a failure, not a retriable action).
- **Logging:** system log / monitoring pipeline; notification if severe. **Why it exists:** the invariant that **nothing fails silently** (Chapter 02 §10) — every unexpected failure becomes a visible, logged fact.

---

## 7. Catalog at a glance

| Event | Producer | Key consumers | Persisted to |
|---|---|---|---|
| `MARKET_TICK` | Market Data | Indicators, dashboard | `market_ticks` (sampled/TTL) |
| `CANDLE_CLOSED` | Market Data | Indicators, Strategy | `candles` |
| `INDICATORS_UPDATED` | Indicators | Context/Strategy, dashboard | — |
| `SIGNAL_CREATED` | Strategy | dashboard, logger | `signals` |
| `RISK_BLOCKED` | Risk | dashboard, notifications | `risk_logs` |
| `ORDER_PLACED` | Order Manager | dashboard | `orders` (PLACED) |
| `ORDER_FILLED` | Order Manager | **Position Engine**, dashboard | `orders` (FILLED) |
| `POSITION_UPDATED` | Position | Portfolio, PnL, dashboard | `positions` |
| `PNL_UPDATED` | PnL | dashboard, **Risk** | derived |
| `BROKER_CONNECTED` | Broker | pipeline, dashboard | `trade_logs` |
| `BROKER_DISCONNECTED` | Broker | **Order Manager**, dashboard | `trade_logs` |
| `MARKET_OPEN` | Session mgr | Strategy, dashboard | `trade_logs` |
| `MARKET_CLOSE` | Session mgr | Strategy, Position, dashboard | `trade_logs` |
| `SYSTEM_ERROR` | any | monitoring, dashboard | system log |

---

## 8. Failure modes & recovery

- **Consumer offline** → misses broadcasts; recovers by resync from Mongo snapshots on reconnect (§4, case 1).
- **Redis Pub/Sub unavailable** → no fan-out; the system halts new orders and surfaces `SYSTEM_ERROR` until Redis returns (Chapter 08 §11).
- **Duplicate delivery on resync** → harmless *iff* consumers are idempotent (§5). This is the one rule a new consumer author must not skip.
- **A durable side-effect fails** → it's a BullMQ job, so it retries with backoff and lands in a dead-letter/failed set for inspection if it exhausts retries (Chapter 08 §6).

---

## 9. Roadmap

- **Redis Streams** would add durable, replayable events with consumer groups (Chapter 08 §12) — adopt if a future consumer must never miss history or if exactly-once processing becomes worth the complexity. Until then, at-least-once + idempotent consumers is the contract.
- **A schema registry** for `contracts` payloads (versioned event schemas) once external or long-lived consumers need backward-compatibility guarantees.

---

*Previous: **[08_REDIS_ARCHITECTURE.md](08_REDIS_ARCHITECTURE.md)**  ·  Next: **[10_WEBSOCKET_SYSTEM.md](10_WEBSOCKET_SYSTEM.md)** — how these events reach the dashboard over Socket.IO.*
