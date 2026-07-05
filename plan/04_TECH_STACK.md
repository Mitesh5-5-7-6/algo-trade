# 04 — Tech Stack

> This chapter is the justification record for every technology in the system. The rule enforced here (and stated in Chapter 00): never write "we use X." Always write "we use X **because** Y, instead of Z." A stack without recorded reasons is a stack no one can safely change later.

---

## 1. Purpose

To document each technology, the specific job it does, why it was chosen, and the alternative that was rejected. When someone six months from now asks "why MongoDB and not Postgres?" or "why Fastify?", the answer is here rather than lost.

---

## 2. Language & runtime

### TypeScript on Node.js

**Job:** the language and runtime for the entire backend and the strategy/engine logic.

**Why TypeScript (not plain JavaScript):** this system moves money based on the shapes of objects — an order, a signal, a position. A wrong field or a stringly-typed number is a mis-executed trade. TypeScript makes those shapes checkable at compile time, and combined with the shared `core` package (Chapter 03) it gives one type definition consumed by both server and dashboard. The type-checker becomes a second reviewer that never gets tired.

**Why Node (not Python, despite Python's quant ecosystem):** the system is fundamentally an I/O-bound, event-driven, real-time application — WebSockets in, WebSockets out, Redis, Mongo — which is exactly Node's event-loop sweet spot, and it lets the backend and the React dashboard share one language and one set of type definitions. The heavy-numeric work here (indicators) is light enough to run in-process; genuinely heavy analysis is offloaded to workers (Chapter 02 §9). See the concurrency caveat in §8.

---

## 3. Backend framework

### Fastify

**Job:** the HTTP server for the operator's control-plane API and the host process for all engines.

**Why Fastify (not Express):** Fastify is schema-first and low-overhead. Its per-route schema validation and fast JSON serialization matter in a system with a real-time path, and its plugin/encapsulation model keeps the composition root (Chapter 05) clean. Express is more ubiquitous but slower and unopinionated about validation, which would push more correctness burden onto hand-written code.

---

## 4. Validation

### Zod

**Job:** validate and parse every input at the system boundary; define the canonical entity schemas in `core`.

**Why Zod:** it validates at runtime *and* infers the TypeScript type from the same schema — so one Zod schema is simultaneously the runtime guard and the compile-time type. Defining these in `core` means the request validation, the DB model expectation, and the dashboard's understanding of a shape all derive from **one** definition. This is the single-source-of-truth invariant applied to data shape.

**Why validate at the boundary specifically:** bad data must be rejected before it reaches a service or an engine, so that everything past the boundary can *trust* its inputs and not re-check them. See Chapter 05 §4.

---

## 5. Realtime transport

### Socket.IO

**Job:** push live state (positions, PnL, order updates, AI summaries, system status) from server to the dashboard.

**Why Socket.IO (not raw WebSocket / `ws`):** it provides automatic reconnection, rooms/namespaces (so the server can target updates), heartbeats, and transport fallbacks out of the box. In a control center, a dropped connection that silently fails to reconnect would leave the operator looking at stale numbers while trading continues — a dangerous illusion. Socket.IO's reconnection and the UI's disconnect handling (Chapter 06 §7) close that gap. Raw `ws` would mean reimplementing all of this by hand.

---

## 6. In-memory data & messaging

### Redis

**Job:** the system's nervous system — five distinct roles, each justified in **[08_REDIS_ARCHITECTURE.md](08_REDIS_ARCHITECTURE.md)**:

1. **Pub/Sub** — fan-out of ticks and events to many consumers (Chapter 02 §6–7).
2. **Cache / hot state** — latest price, latest indicator values, session state; fast reads for the context builder without a Mongo round-trip on every tick.
3. **BullMQ backing store** — durable background job queues.
4. **Session storage** — auth sessions (Chapter 21).
5. **Rate limiting** — protect the API and broker calls.

**Why Redis:** it's the one tool that serves all five roles with sub-millisecond latency, which is what a real-time path needs. Splitting these across five different tools would add operational surface for no benefit.

### BullMQ (on Redis)

**Job:** run background work off the hot path — news fetch/summarize, LLM calls, token refresh, notifications, heavy analytics.

**Why BullMQ:** durable, retryable, Redis-backed queues with good TypeScript support, reusing infrastructure already present. **Why a queue at all:** the event loop must stay free (Chapter 02 §9); a two-second LLM call inline would freeze tick processing, so slow work is queued and processed by workers. Retries matter because news APIs and token refreshes fail transiently and must not silently drop.

---

## 7. Durable storage

### MongoDB

**Job:** the system of record — users, strategies, signals, orders, positions, ticks, candles, logs, tokens, settings (Chapter 07).

**Why MongoDB (not PostgreSQL):** the domain has many varied, evolving document shapes — strategy configs whose parameters differ per strategy, heterogeneous log entries, high-volume tick/candle documents. A flexible document model fits this without rigid migrations for every strategy that adds a parameter, and Mongo's write throughput suits the tick/candle firehose. **The honest trade-off:** Postgres gives stronger relational integrity and transactions; we accept weaker cross-document guarantees because the *money-critical* consistency in this system is enforced in-process by the synchronous critical path and single-owner writes (Chapter 02 §6, §8), not by the database. Where strong per-record consistency matters (orders), that's guarded by the Order Manager choke point, not by DB transactions across tables. This trade-off is worth revisiting if the data model becomes highly relational.

---

## 8. Concurrency note (why the runtime choice constrains design)

Node's single-threaded event loop (Chapter 02 §9) is a deliberate constraint, not an oversight: it keeps the critical decision path simple and race-free *within* a process, but it means **no CPU-heavy or blocking work may run on the hot path**. This is why heavy work is queued (§6) and why the AI contributes a pre-computed confidence value rather than being called synchronously mid-decision (Chapter 02 §4). The stack choice and the architecture are coupled here by design.

---

## 9. Broker

### FYERS

**Job:** the live market-data source (WebSocket feed) and the order-execution backend for Phase 3.

**Why FYERS:** it exposes both a real-time WebSocket market feed and an order API suitable for programmatic trading on Indian exchanges (NSE/BSE). Crucially, the system never depends on FYERS directly — it depends on the `Broker` interface (Chapter 02 §2.4, Chapter 19), so FYERS is a swappable implementation. That abstraction is what makes the broker choice low-risk: a different broker later is a new implementation of one interface.

---

## 10. Frontend

| Piece | Choice | Why |
|---|---|---|
| Framework | **Nextjs** | Component model fits a dashboard of many independent live panels; huge ecosystem. |
| Server-state / data fetching | **TanStack Query** | Caching, background refetch, and cache invalidation for REST data; pairs cleanly with socket-driven cache updates (Chapter 06 §5). |
| Charts | **Lightweight financial charting lib** | Price/PnL charts need to render streaming updates smoothly; a purpose-built financial chart library outperforms general charting for candlesticks and live series. |
| Realtime | **Socket.IO client** | Matches the server transport (§5). |

Detailed structure and the reasoning for the REST-vs-socket split are in **[06_FRONTEND_ARCHITECTURE.md](06_FRONTEND_ARCHITECTURE.md)**.

---

## 11. Build, deploy & ops

| Piece | Choice | Why |
|---|---|---|
| Package manager / workspace | **pnpm** | Strict dependency resolution enforces package boundaries (Chapter 03 §3). |
| Task runner | **Turborepo** | Dependency-aware caching keeps builds/tests fast as packages multiply. |
| Containerization | **Docker** | Reproducible builds; the same image runs in CI and on the VPS (Chapter 22). |
| CI | **GitHub Actions** | Lint, type-check, test, and build on every push before anything ships. |
| Process manager | **PM2** | Keeps the `api` process alive, restarts on crash, manages logs in production (Chapter 22). |
| Hosting | **VPS** | Full control over the long-lived, stateful trading process and its Redis/Mongo neighbors. |

---

## 12. Testing

| Layer | Tool | Why |
|---|---|---|
| Unit / integration | **Vitest (or Jest)** | Fast unit tests colocated per package (Chapter 03 §7); pure functions like indicators and strategy logic are highly testable. |
| End-to-end (dashboard) | **Playwright** | Drives the real dashboard in a browser to verify operator workflows end to end. |

Full approach — including how the deterministic pipeline is tested with recorded market data — is in **[27_TESTING.md](27_TESTING.md)**.

---

## 13. Roadmap

- The stack is chosen so that **scaling out is additive**: Redis + queues already decouple components, so extracting a plane into its own process (Chapter 02 §13) needs no new core technology.
- The one deliberately-flagged revisit point is **MongoDB vs a relational store** (§7): if the data model trends strongly relational, re-evaluate. Until then, in-process invariants carry the consistency load.

---

*Previous: **[03_MONOREPO_STRUCTURE.md](03_MONOREPO_STRUCTURE.md)**  ·  Next: **[05_BACKEND_ARCHITECTURE.md](05_BACKEND_ARCHITECTURE.md)** — the request lifecycle and how the engines are hosted.*
