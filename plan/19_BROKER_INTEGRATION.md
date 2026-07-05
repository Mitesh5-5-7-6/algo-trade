# 19 — Broker Integration

> Prerequisites: **[02_MASTER_ARCHITECTURE.md](02_MASTER_ARCHITECTURE.md)** §2.4 (interchangeable broker), **[11_PAPER_TRADING_ENGINE.md](11_PAPER_TRADING_ENGINE.md)** (the other implementation), **[12_ORDER_ENGINE.md](12_ORDER_ENGINE.md)** §8 (the reconciliation this layer must support).

---

## 1. Purpose

The broker layer is the system's **boundary with the outside financial world**, and it has two distinct duties:

1. **Inbound — market data:** maintain the FYERS WebSocket feed and deliver raw messages to the Market Data Engine (Chapter 17).
2. **Outbound — execution:** implement the `Broker` interface the Order Manager calls (Chapter 12).

Both duties live behind interfaces so that *nothing else in the system knows FYERS exists.* This chapter specifies those interfaces, the FYERS realities behind them (auth, tokens, rate limits, reconnection), and the guarantees the layer must uphold for live trading to be safe.

---

## 2. The `Broker` interface (the contract everything depends on)

```
Broker {
  // execution
  execute(order): FillResult | Rejection      // Ch 12 §4
  cancel(orderId): void
  status(clientOrderId): OrderStatus          // reconciliation, §6
  onOrderUpdate(callback)                     // async fills/rejections

  // market data
  connect(): void
  disconnect(): void
  subscribe(symbols[]): void                  // Ch 17 §7
  onData(callback)                            // raw messages -> MDE
  onConnectionChange(callback)                // -> BROKER_CONNECTED/DISCONNECTED
}
```

Two implementations: **`PaperBroker`** (Chapter 11 — execution simulated in-process; market data still real, from FYERS) and **`FyersBroker`** (both sides real). Selected once, at the composition root (Chapter 05 §3).

**Why one interface for both duties:** the Order Manager and the Market Data Engine each depend on *their slice* of this contract and nothing more. Note the Phase 1 subtlety: paper trading uses the FYERS *data* side with the Paper *execution* side — real prices, simulated fills — which is exactly what makes paper P&L meaningful (Chapter 11 §2).

---

## 3. FYERS authentication & the token lifecycle

FYERS uses an OAuth-style flow: app credentials → operator completes a login/consent step → auth code → **access token**. The operational fact that shapes the design: **FYERS access tokens expire daily.**

Consequences, each already provisioned in earlier chapters:

- Tokens are persisted in `broker_tokens`, **encrypted at rest** (Chapter 07, Chapter 24) — they are credentials to move real money.
- A scheduled **BullMQ `jobs:token-refresh`** job (Chapter 08 §6) renews/re-establishes the token *before* expiry each trading morning. **Why a durable job:** a silently missed refresh means no feed and no orders at the open — the queue's persistence and retries (Chapter 08 §10) are what make this reliable rather than hopeful.
- If refresh requires operator interaction (FYERS flows can), the job raises a **notification** (Chapter 07) early enough to act before the bell — the system asks for help *before* it's blind, not after.
- Token state is validated at connect; an invalid/expired token is a `BROKER_DISCONNECTED`-class failure, not a mysterious stream of API errors.

**Two identities, never conflated:** the operator authenticates *to the system* (sessions, Chapter 21); the system authenticates *to FYERS* (these tokens). The dashboard never sees or handles broker tokens.

---

## 4. Inbound: the market-data feed

- The layer opens the FYERS market WebSocket, authenticates it with the current token, and subscribes to the working set the Market Data Engine requests (Chapter 17 §7).
- Raw messages are handed to `onData` **untranslated** — normalization is the Market Data Engine's job (Chapter 17 §2). **Why the layer doesn't normalize:** keeping this layer a thin transport means broker quirks are handled in exactly one downstream place, and the layer itself stays simple enough to be obviously correct.
- **Connection health is actively verified**, not assumed: heartbeats/pings per the FYERS protocol, plus the Market Data Engine's independent silence detection (Chapter 17 §8) as the second opinion. On failure: emit `BROKER_DISCONNECTED`, reconnect with **exponential backoff + jitter** (immediate tight-loop retries hammer a struggling endpoint and can trigger bans), re-authenticate, **re-subscribe the working set** (subscriptions do not survive reconnection), then emit `BROKER_CONNECTED`. The Order Manager's halt-on-disconnect (Chapter 12 §7) and the engine's resubscribe (Chapter 17 §8) hang off these two events.

---

## 5. Outbound: order execution against FYERS

- `execute(order)` maps the internal order (Chapter 12 §4) to the FYERS order API — symbol format translation, side/type/product mapping, quantity — and submits.
- **Every order carries our own client order reference.** FYERS accepts a client identifier; we always set it to our `orderId`. **Why this is non-negotiable:** it is the key that makes `status(clientOrderId)` — and therefore the unknown-outcome reconciliation in Chapter 12 §8 — possible. Without a client reference, a timed-out submission is unresolvable: you cannot ask the broker "did *my* order go through?" if nothing ties their record to yours.
- Fills and rejections arrive **asynchronously** via the order-update stream/callbacks → `onOrderUpdate` → the Order Manager records the outcome and emits `ORDER_FILLED`/rejection (Chapter 12 §4.5). Live fills are not synchronous responses the way paper fills are — the Order Manager's state machine (`PLACED → PENDING → FILLED`) already models this.
- **Rejection mapping:** FYERS rejection codes are translated to the internal typed reasons (margin, invalid symbol, session, rate limit…) so `orders.status = REJECTED` records a legible cause (Chapter 07), not an opaque broker code.

---

## 6. Rate limiting (protecting the connection itself)

All outbound FYERS calls pass through the Redis rate limiter (`ratelimit:broker:*`, Chapter 08 §8), budgeted **below** FYERS's published caps.

**Why self-throttling below the cap:** exceeding broker limits doesn't just fail one call — it can throttle or suspend the API session, taking down *all* execution and management at once. The limiter converts a potential account-level outage into, at worst, a briefly delayed call. Priority within the budget: order placement and cancellation outrank status polling — if anything must wait, it's the read, never the trade.

---

## 7. Failure modes & guarantees

- **Feed drop** → §4 reconnect discipline; data-side staleness handled by Chapter 17; order halt by Chapter 12 §7.
- **Order submission timeout** → the unknown-outcome case: the layer guarantees `status(clientOrderId)` works so the Order Manager can *reconcile-then-decide*, never blind-retry (Chapter 12 §8). This guarantee — client reference on every order + a working status lookup — is this layer's most important contract with the rest of the system.
- **Token expiry mid-session** → detected via auth errors → treated as disconnect → refresh path (§3) → reconnect. Never silently retried against a dead token.
- **FYERS API errors** → mapped to typed errors (Chapter 05 §5), logged with context, surfaced; systemic patterns (every call failing) escalate to `BROKER_DISCONNECTED` semantics rather than drip-failing.

---

## 8. Data & events

- **Reads/writes:** `broker_tokens` (via its owner/repository, Chapter 07); `ratelimit:broker:*` counters.
- **Produces:** `BROKER_CONNECTED`, `BROKER_DISCONNECTED` (Chapter 09); raw data → Market Data Engine; order updates → Order Manager.
- **Secrets discipline:** tokens are never logged, never sent to the dashboard, and appear in memory only inside this layer (Chapter 24).

---

## 9. Roadmap

- **Bracket/cover order support** at the broker (Chapter 12 §9) — stop-loss protection that survives our process dying, the single biggest live-safety upgrade.
- **Historical data API** integration for candle back-fill and instant warm-up (Chapters 17 §10, 18 §9).
- **A second broker adapter** — the interface (§2) is the proof-of-design; adding one touches this layer and the composition root only.

---

*Previous: **[18_INDICATOR_ENGINE.md](18_INDICATOR_ENGINE.md)**  ·  Next: **[20_AI_ENGINE.md](20_AI_ENGINE.md)** — the intelligence plane and its hard boundary.*
