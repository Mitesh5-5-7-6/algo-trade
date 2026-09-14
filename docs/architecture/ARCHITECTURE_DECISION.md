# Architecture Decision — Neelkanth Trader

**Status:** Architecture baseline
**Decision:** Modular Trading Core + isolated R&D platform + isolated Paper/Live data boundaries
**Supersedes:** `Algo_Trade_Architecture_Decision.md`, `Algo_Trade_AI_Agent_RnD_Plan_Tomorrow.md` (both deleted)

This document is the stable architectural authority. It answers: what did we choose, why, what did we reject, what is mandatory, what is deferred, what are the security boundaries, what may become a service later, and what must never happen.

It deliberately carries **no implementation roadmap**. Phasing lives in [RND_RESEARCH_SPECIFICATION.md](RND_RESEARCH_SPECIFICATION.md); what exists today lives in [CURRENT_STATE.md](CURRENT_STATE.md).

Every section is tagged with one status:

| Tag           | Meaning                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `DECIDED`     | Settled. Changing it requires superseding this document.               |
| `PROPOSED`    | The intended design. Not built, not binding until promoted to DECIDED. |
| `DEFERRED`    | Deliberately postponed with a named trigger for revisiting.            |
| `CURRENT GAP` | The repository contradicts the decision today. See CURRENT_STATE.md.   |

---

## 1. Decision — `DECIDED`

> Neelkanth Trader is a single TypeScript monorepo containing a modular, broker-agnostic Trading Core, an independently deployable and internally distributed R&D platform, and isolated Paper and Live runtime environments. Each environment owns its own MongoDB database and its own Redis instance. R&D produces research and strategy candidates; historical validation proves them; Paper validates them under simulated trading; only controlled promotion makes a strategy eligible for Live. The Risk Engine is the mandatory execution gate, AI never receives direct broker access, and individual services are extracted only when an actual scaling, security, runtime, deployment or failure-isolation requirement justifies the distributed-system complexity.

The guiding principle:

> Separate where isolation matters. Modularise where components belong together. Distribute only when the operational benefit is worth the complexity.

---

## 2. The three architectural personalities — `DECIDED`

This platform is not one architecture. It is three, and each is correct for its own workload. Every "should this be a service?" question resolves by asking which personality the component belongs to.

|                      | **Trading**                                                | **R&D**                                                                    | **Dashboard**                                                      |
| -------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Demands              | Consistency, safety, determinism, low latency, reliability | Experimentation, compute, AI, backtesting, historical analysis, large jobs | Presentation, realtime updates, research visualisation, monitoring |
| Architecture         | Modular, tightly coupled _internally_                      | Distributed, asynchronous                                                  | Stateless frontend + API                                           |
| What a failure means | Money at risk                                              | A job is retried                                                           | A screen is stale                                                  |
| Scaling axis         | Vertical; one correct process                              | Horizontal; many workers                                                   | Horizontal; stateless replicas                                     |

The most common architectural mistake available to this project is applying the Trading personality's caution to R&D, or R&D's distribution enthusiasm to Trading.

---

## 3. Topology — `DECIDED`

```
                         ┌─────────────────────────┐
                         │    NEELKANTH TRADER     │
                         │        MONOREPO         │
                         └────────────┬────────────┘
                                      │
                 ┌────────────────────┴────────────────────┐
                 │                                         │
                 ▼                                         ▼
        ┌─────────────────┐                       ┌─────────────────────┐
        │     R&D LAB     │                       │  TRADING PLATFORM   │
        │                 │                       │                     │
        │ Research API    │                       │ Trading API         │
        │ Research Worker │                       │ Market Data         │
        │ Replay          │                       │ Candle Engine       │
        │ Backtesting     │                       │ Indicator Engine    │
        │ AI              │                       │ Strategy Engine     │
        │ RAG             │                       │ Risk Engine         │
        │ Reports         │                       │ Order Manager       │
        └────────┬────────┘                       │ Position Engine     │
                 │                                │ Trade Engine        │
          Mongo R&D                               │ PnL                 │
          Redis R&D                               └──────────┬──────────┘
                                                             │
                                                ┌────────────┴────────────┐
                                                │                         │
                                                ▼                         ▼
                                       ┌────────────────┐       ┌────────────────┐
                                       │     PAPER      │       │      LIVE      │
                                       │                │       │                │
                                       │ PaperBroker    │       │ FyersBroker    │
                                       │ Mongo Paper    │       │ Mongo Live     │
                                       │ Redis Paper    │       │ Redis Live     │
                                       └────────────────┘       └───────┬────────┘
                                                                        │
                                                                        ▼
                                                                      FYERS
```

The twenty-second version:

```
ONE MONOREPO
     │
     ├── R&D PLATFORM ........ distributed workers, own Mongo + Redis
     │
     └── TRADING CORE ........ modular, in-process critical path
              │
         ┌────┴────┐
       PAPER      LIVE
   PaperBroker  FyersBroker
```

---

## 4. Rejected alternatives — `DECIDED`

### 4.1 The reframe that matters

**Separate deployment ≠ microservice.** Running `neelkanth-dashboard`, `neelkanth-trading` and `neelkanth-rnd` as three independently deployed projects is excellent and is exactly what this document adopts. The question is never "how many deployments" — it is _where the boundaries go_.

Full microservices are not inherently bad. They are an engineering response to a real problem. This section records why that problem does not exist yet on the trading path, and §14 records the triggers that would create it.

### 4.2 Reason 1 — trading needs atomic decisions

When a strategy emits BUY, the Risk Engine must immediately see current positions, exposure, open and in-flight orders, available margin, daily loss, maximum open positions, the kill switch, and per-strategy limits.

In-process, that is a function call under one state boundary:

```
Strategy → Risk Engine → Order Manager → Broker
```

Across services, the same decision acquires request timeouts, retries, idempotency keys, stale state, partial failure, message ordering and distributed transactions — a large amount of machinery wrapped around one simple decision.

### 4.3 Reason 2 — the real risk is consistency, not latency

"Microservices are slower" is true and is not the main objection. The main objection is correctness.

Two signals arrive nearly simultaneously. Both Risk evaluations read `position = 1`. Both approve. Both create orders. The position limit is silently exceeded.

A modular core protects that state transition directly. Microservices can solve it too — with distributed locking, transactional messaging, or a single-writer partition — but that converts one engineering problem into one engineering problem _plus_ distributed-systems engineering.

### 4.4 Reason 3 — the order lifecycle would cross five services

On a broker `FILLED`, four things must move together: Order, Position, Trade, PnL. Split across services, a single fill can land as:

```
Order Service      SUCCESS
Position Service   SUCCESS
Trade Service      TIMEOUT
PnL Service        DOWN
```

That is a distributed consistency problem invented before breakfast, in exchange for nothing.

### 4.5 Verdict

| Architecture                            | Today        | Later                 |
| --------------------------------------- | ------------ | --------------------- |
| Monolith                                | Too coupled  | Bad                   |
| Modular monolith                        | Excellent    | Still useful          |
| **Modular Trading Core + R&D services** | **Best fit** | **Excellent**         |
| Full microservices                      | Over-complex | Potentially excellent |
| Full microservices from day one         | No           | No                    |

This architecture is deliberately designed to **evolve into** full microservices without rewriting business logic. Engines are constructed with injected ports, not ambient singletons, precisely so that a port can later become a network call without the engine noticing.

---

## 5. Principles — `DECIDED`

**5.1 Backend is the source of truth.** The frontend never decides BUY, SELL, quantity, stop loss, take profit, risk acceptance, or broker state.

**5.2 Strategy generates intent, not execution.** A strategy emits a signal. It never calls the broker.

**5.3 The Risk Engine is mandatory.** `Strategy → Broker` must not exist as a code path. Only `Strategy → Risk → Order Manager → Broker`.

**5.4 AI never trades.** AI may research, analyse, compare, inspect patterns, propose hypotheses, suggest parameters, create candidates and retrieve history. `AI → placeOrder()` must not exist.

**5.5 Paper and Live are isolated.** Separate databases, separate Redis, separate credentials, separate deployments, separate monitoring.

**5.6 R&D must not be required for live trading.** If R&D is down, Paper and Live continue.

**5.7 Events are for boundaries.** Inside the Trading Core, prefer direct typed calls. At system boundaries, use events.

**5.8 Fail closed.** When a critical condition cannot be evaluated, the answer is no order.

---

## 6. Monorepo and package boundaries — `DECIDED`

**Do not refactor the existing package layout to make a diagram prettier.** The current tree is correct and stays as it is:

```
neelkanth-trader/
├── apps/
│   ├── api                 Trading API + engine runtime
│   └── dashboard           Next.js UI
├── packages/
│   ├── broker              Broker contract, FyersBroker, PaperBroker, slippage, charges
│   ├── config              Env loading and validation
│   ├── contracts           Event catalog, envelope, channels
│   ├── core                Domain primitives and Zod schemas
│   ├── db                  Mongo client, collection registry, repositories
│   ├── engines             Market data, indicators, strategy, risk, order, position, exit
│   ├── indicators          Deterministic indicator maths
│   ├── logger              Structured logging
│   ├── redis               Client, keyspace, cache, event bus
│   └── strategies          Strategy definitions and registry
├── docs/
├── scripts/
└── infrastructure (as needed)
```

Additions are made **only when the work reaches them**:

| When                                            | Add                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| R&D research API and job queue land             | `apps/research-api`, `apps/research-worker`, `packages/research` |
| AI workload justifies its own runtime           | `apps/research-ai`                                               |
| Replay or backtest volume justifies parallelism | `apps/replay-worker`, `apps/backtest-worker`                     |

Renaming `engines` to `trading-engine`, or splitting `risk-engine` and `validation` into their own packages, buys nothing and costs a full pass over the project-reference graph. It is not done.

### 6.1 Structural constraints on adding a package — `DECIDED`

Two mechanical constraints govern every new workspace entry:

1. [pnpm-workspace.yaml](../../pnpm-workspace.yaml) globs only `apps/*` and `packages/*`. Nested layouts such as `packages/research/*` require editing that file.
2. [tsconfig.json](../../tsconfig.json) holds a **hand-maintained, dependency-ordered** `references` array. A new package must create its own `tsconfig.json` + `tsconfig.build.json` and be inserted at the correct position, or the root `tsc -b` graph is silently incomplete.

Package naming is `@neelkanth/*`. Internal dependencies use `workspace:*`.

### 6.2 Import direction — `DECIDED`

`packages/` must not import from `apps/`. Where a value is genuinely needed on both sides, it is duplicated deliberately and the duplication is commented, as with the FYERS callback path in [packages/config/src/index.ts](../../packages/config/src/index.ts).

---

## 7. Trading Core — `DECIDED`

```
Market Data → Candle Engine → Indicator Engine → Strategy Engine
   → Risk Engine → Order Manager → Broker Adapter → Broker
   → Order Reconciliation → Position → Trade → PnL
```

| Module           | Responsibility                                                             |
| ---------------- | -------------------------------------------------------------------------- |
| Market Data      | Broker socket, ticks, quotes, instrument data, symbol normalisation        |
| Candle Engine    | Interval aggregation from ticks; provenance tracking                       |
| Indicator Engine | Deterministic, framework-independent indicator computation                 |
| Strategy Engine  | Signals and intents only                                                   |
| Risk Engine      | Sizing, exposure, limits, duplicate protection, lot awareness, kill switch |
| Order Manager    | Idempotency, lifecycle, persistence, submission, rejection, reconciliation |
| Position Engine  | Fill projection, average entry, realised/unrealised PnL                    |
| Trade Engine     | Completed-trade construction — see §9                                      |
| Broker Adapter   | One contract, many implementations                                         |

Internal code uses a normalised symbol model rather than spreading FYERS-specific symbol strings through the system.

**Critical-path regime — `DECIDED`.** `Strategy → Risk → Order` is a synchronous in-process call. Everything downstream of a fill (`Position`, `PnL`) is an event-bus projection. This split is deliberate: the decision is atomic, the bookkeeping is eventual.

---

## 8. Environments — `PROPOSED` (today: `CURRENT GAP`)

### 8.1 The three environments

|                         | R&D                                                                                   | Paper                                                              | Live                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Owns                    | Research, historical data, replay, patterns, experiments, backtests, AI, RAG, reports | Paper orders, positions, trades, PnL, broker events, strategy runs | Real orders, positions, trades, PnL, broker events, risk events, strategy runs |
| Mongo                   | Mongo R&D                                                                             | Mongo Paper                                                        | Mongo Live                                                                     |
| Redis                   | Redis R&D                                                                             | Redis Paper                                                        | Redis Live                                                                     |
| Broker                  | none                                                                                  | PaperBroker                                                        | FyersBroker                                                                    |
| FYERS order credentials | **NEVER**                                                                             | **NEVER**                                                          | Only here                                                                      |

The database provides environment separation. Collections are **not** renamed `paper_orders` / `live_orders`; Paper and Live share one logical schema in separate databases.

### 8.2 Logical vs physical separation — `DECIDED` / `DEFERRED`

| Separation                                   | Decision                                                 |
| -------------------------------------------- | -------------------------------------------------------- |
| R&D separate Mongo                           | `DECIDED` — different workload, different failure domain |
| R&D separate Redis                           | `DECIDED`                                                |
| Paper separate database                      | `DECIDED`                                                |
| Live separate database                       | `DECIDED`                                                |
| Paper separate Redis instance                | `DECIDED`                                                |
| Live separate Redis instance                 | `DECIDED`                                                |
| Paper/Live on separate **physical clusters** | `DEFERRED`                                               |

Separate Redis instances are not a cost preference — they are a correctness requirement. [packages/redis/src/keys.ts](../../packages/redis/src/keys.ts) has **no environment component in any key** (`hot:price:${symbol}`, `risk:dailyLoss:${dateIST}`, `session:*`). Two environments sharing one Redis would collide outright. Until the keyspace carries an environment prefix, separate instances are the only available isolation.

Separate physical clusters are deferred because the boundary that actually provides safety is credentials, not hardware: only the Live deployment holds FYERS order credentials, and that is enforced by environment configuration. Revisit when Live capital, regulatory obligation, or noisy-neighbour latency makes shared infrastructure a real risk.

### 8.3 Target environment configuration — `PROPOSED`

```env
# R&D
APP_ENV=rnd
BROKER_ORDER_ENABLED=false
LIVE_TRADING_ENABLED=false

# Paper
APP_ENV=paper
PAPER_TRADING_ENABLED=true
BROKER_ORDER_ENABLED=false
LIVE_TRADING_ENABLED=false

# Live
APP_ENV=live
PAPER_TRADING_ENABLED=false
LIVE_TRADING_ENABLED=true
BROKER_ORDER_ENABLED=true
```

Each environment supplies its own `MONGO_URI` and `REDIS_URL`. Secrets are never copied between environments.

### 8.4 Today's reality — `CURRENT GAP`

None of `APP_ENV`, `PAPER_TRADING_ENABLED`, `LIVE_TRADING_ENABLED` or `BROKER_ORDER_ENABLED` exists. Separation runs on a single axis — `BROKER_MODE=paper|live` in [packages/config/src/index.ts](../../packages/config/src/index.ts) — stamped onto orders and positions as `mode`, with one Mongo database and one Redis instance shared by both modes. [apps/api/src/composition-root.ts](../../apps/api/src/composition-root.ts) additionally constructs a deliberate hybrid in paper mode: live FYERS market data spliced onto paper execution. Because of that hybrid, `mode` is injected explicitly and must never be inferred from the wired broker object.

Recorded in detail in [CURRENT_STATE.md](CURRENT_STATE.md).

### 8.5 Configuration philosophy — `DECIDED`

> Environment = infrastructure identity and secrets. Database = trading behaviour tuned at runtime.

Risk limits, the kill switch, market hours, holidays and broker tokens are runtime settings in Mongo, not environment variables. Connection strings, credentials and encryption keys are environment variables, never database rows.

---

## 9. Trade and order lifecycle — `PROPOSED`

### 9.1 Order lifecycle

```
Signal → Entry Intent → Risk Validation ──REJECTED──┐
                              │                      │
                            PASS                     │
                              ▼                      │
                       Order Created                 │
                              ▼                      │
                     Broker Submission ──REJECTED────┤
                              │                      │
                          ACCEPTED                   ▼
                              ▼                  risk_logs
                          PENDING
                              ▼
                           FILLED
                              ▼
                       ACTIVE TRADE
                              │
        ┌──────────┬──────────┼──────────┬──────────┐
      STOP      TARGET    STRATEGY     TIME      SESSION
       LOSS                 EXIT       EXIT       CLOSE
        └──────────┴──────────┼──────────┴──────────┘
                              ▼
                        EXIT FILLED
                              ▼
                      COMPLETED TRADE
                              ▼
                             PnL
```

> `PENDING` does not mean `FILLED`. A completed trade is never created until execution is actually known.

### 9.2 The Completed Trade is the canonical outcome primitive — `DECIDED`

A signal is not an outcome. An entry is not an outcome. Research without completed trades has no labels, and a platform without completed trades cannot answer what any decision actually earned.

Minimum fields:

```
tradeId, strategyId, strategyVersion, symbol, side
entryOrderId,  entryTime,  entryPrice
exitOrderId,   exitTime,   exitPrice
quantity, exitReason
grossPnl, charges, slippage, netPnl
entryPatternId, marketContext, dataProvenance
```

Exit reasons:

```
STOP_LOSS  TAKE_PROFIT  STRATEGY_EXIT  TIME_EXIT
SESSION_CLOSE  MANUAL_EMERGENCY  BROKER_RECONCILIATION
```

**This entity does not exist today.** See [CURRENT_STATE.md](CURRENT_STATE.md); it is the Phase 2 implementation target.

### 9.3 Exit model — `PROPOSED`

Every entry must be able to reach an outcome. The exit model requires stop loss, take profit, strategy exit, time exit and session square-off. Without it, `Pattern → Strategy → Outcome` has no valid label to learn from.

---

## 10. Data architecture — `DECIDED`

### 10.1 Mongo is durable business state

Trading databases (Paper and Live, one logical schema each):

```
orders  positions  trades  signals  strategy_runs
broker_events  risk_events  pnl  candles
```

R&D database:

```
candles  patterns  pattern_observations
strategy_candidates  strategy_experiments
backtests  walk_forward_results
research_reports  ai_analysis  documents  embeddings
```

Do not create many collections that duplicate one concept. Daily, weekly, monthly and quarterly research are **one** `research_reports` collection with a `period` field, not four collections.

### 10.2 Redis is coordination, not storage

| Need                                | Home                           |
| ----------------------------------- | ------------------------------ |
| Local high-frequency state          | Process memory                 |
| Cross-process high-frequency events | Carefully optimised event path |
| Durable business state              | MongoDB                        |
| Realtime UI updates                 | WebSocket / Socket.IO          |
| Long-running work                   | Queue                          |
| Critical cross-system events        | Durable event / outbox         |

Per-environment usage:

- **R&D Redis** — research job queues, replay jobs, AI jobs, embeddings caches, research events and locks.
- **Paper Redis** — paper market events, order queues, worker coordination, locks, temporary state.
- **Live Redis** — live market events, order coordination, risk locks, broker events, recovery state.

**Never** adopt this pattern by default:

```
every tick → Redis SET → Redis PUBLISH → dashboard Redis GET
```

The event bus is in-process unless an event genuinely crosses a process boundary. Publishing a tick over a network to the same process that produced it is the single most expensive mistake available here, and it has already been made once and corrected.

### 10.3 R&D ingestion — `DECIDED`

Do not fan every live tick into R&D. Prefer:

```
Live Market Data → Trading System → Normalised 5m Candle → R&D ingestion
```

Tick-level research is added only on proven need.

### 10.4 Retention — `DECIDED`

Temporary operational state and historical research evidence have different lifetimes. Short Redis TTLs suit the former. Research evidence must never vanish because an operational TTL expired. Research retention is explicit and separate.

---

## 11. Cross-boundary communication — `PROPOSED`

Versioned, validated contracts between R&D and Trading:

```
R&D ──strategy.candidate.created──▶ Validation
    ◀──validation.completed────────
    ──promotion.candidate.created─▶ Approval ──▶ Live Strategy Registry
```

```json
{
  "event": "strategy.candidate.created",
  "candidateId": "SC-2026-001",
  "strategyId": "EMA_ORB_COMBINATION",
  "version": "0.1.0",
  "source": "research"
}
```

### 11.1 Transactional outbox — `PROPOSED`

Dual writes lose events:

```
Mongo write    SUCCESS
Redis publish  FAILED     → state changed, event lost
```

For critical boundaries, write business state and the outbox event in one Mongo transaction and let an outbox worker publish. Good candidates: order state changes, completed trades, broker events, strategy promotion, validation completion. Do not use an outbox for every trivial event.

---

## 12. Strategy promotion — `DECIDED`

```
RESEARCH → CANDIDATE → HISTORICAL VALIDATION ──FAIL──▶ REJECTED
                              │
                            PASS
                              ▼
                      PAPER VALIDATION ──FAIL──▶ REJECTED
                              │
                            PASS
                              ▼
                    PROMOTION CANDIDATE → APPROVAL → LIVE ELIGIBLE → LIVE
```

AI may create a candidate. AI may never bypass validation or approval.

---

## 13. Security boundaries — `DECIDED`

### 13.1 The FYERS boundary

```
Live Trading Core ──▶ FyersBroker ──▶ FYERS

R&D    ──✗──▶ FYERS
Paper  ──✗──▶ FYERS
```

This is a hard security boundary, not a convention. FYERS belongs only behind the Live broker adapter.

### 13.2 Live safety gates

Live order placement requires **all** of:

```
APP_ENV=live
LIVE_TRADING_ENABLED=true
BROKER_ORDER_ENABLED=true
valid FYERS credentials
correct static IP
Risk Engine enabled
strategy promoted
trading session allowed
kill switch NOT active
```

Any critical condition unmet ⇒ **NO ORDER**. Fail closed.

### 13.3 Secrets

Never commit `.env`, tokens, broker secrets, private keys or API secrets. AI tools never receive production secrets.

---

## 14. When to extract a service — `DECIDED`

A component becomes a separately deployed service when one or more is true:

1. It needs independent scaling.
2. It has a different failure domain.
3. It has a different deployment lifecycle.
4. It has a clear ownership boundary.
5. It requires a different runtime.
6. It is computationally expensive.
7. It requires security isolation.
8. It needs independent availability.

### 14.1 Concrete extraction triggers

| Component     | Trigger                                                                      |
| ------------- | ---------------------------------------------------------------------------- |
| Market Data   | 1000+ instruments, multiple consumers, multiple brokers, independent scaling |
| Backtesting   | Hundreds to thousands of concurrent jobs                                     |
| AI            | GPU workloads, long-running inference, a different deployment lifecycle      |
| Replay        | Large historical datasets, parallel processing                               |
| Notifications | Email, Telegram, WhatsApp, webhooks — multiple consumers                     |

When AI proposes 500 parameter combinations, backtesting becomes 500 queued jobs across 1 worker or 20. That is exactly what service extraction is good at, and it touches Live trading not at all.

### 14.2 Component decision matrix

| Component         | In Trading Core initially | Separate deployment initially |
| ----------------- | ------------------------- | ----------------------------- |
| Strategy Engine   | Yes                       | No                            |
| Indicator Engine  | Yes                       | No                            |
| Risk Engine       | Yes                       | No                            |
| Order Manager     | Yes                       | No                            |
| Broker Adapter    | Yes                       | No                            |
| Position Manager  | Yes                       | No                            |
| Trade Manager     | Yes                       | No                            |
| PnL               | Yes                       | No                            |
| Market Data       | Yes                       | Eventually, if needed         |
| R&D API           | No                        | Yes                           |
| R&D Worker        | No                        | Yes                           |
| R&D AI            | No                        | Yes                           |
| Historical Replay | No                        | Eventually                    |
| Backtesting       | No                        | Eventually                    |
| Dashboard         | No                        | Yes                           |

Poor early candidates are Risk Engine, Order Manager and Position Manager — extracting them puts network calls in the critical trading path.

---

## 15. Broker contract — `DECIDED` (extensions `PROPOSED`)

The Trading Core is broker-agnostic. One contract, several implementations:

```
Broker
 ├── PaperBroker
 ├── FyersBroker
 └── ScriptedFakeBroker (test double)
```

Current interface — [packages/broker/src/broker.ts](../../packages/broker/src/broker.ts), nine methods:

```
execute()   cancel()   status()   onOrderUpdate()
connect()   disconnect()   subscribe()   onData()   onConnectionChange()
```

Proposed additions, each with a named consumer:

| Method                                         | Needed by                                   |
| ---------------------------------------------- | ------------------------------------------- |
| `getHistory()`                                 | Historical candle ingestion — Phase 1       |
| `getPositions()`, `getOrders()`, `getTrades()` | Startup reconciliation against broker truth |
| `getMargin()`                                  | Authoritative margin checks for F&O         |
| `getInstruments()`                             | Instrument master refresh                   |

---

## 16. Reconciliation — `PROPOSED`

The platform must recover from API restart, worker restart, Redis restart, Mongo restart, broker network failure, WebSocket disconnect, missed order update and process crash.

```
Load local state → Query broker → Compare → Reconcile
   → Update orders → Update positions → Update trades/PnL
```

Broker execution state is authoritative.

---

## 17. Dashboard — `DECIDED`

Displays market, signals, orders, positions, trades, PnL, strategies, research, reports, risk and system health.

Never implements BUY logic, SELL logic, risk calculations, broker calls or strategy calculations.

Realtime updates use WebSocket/Socket.IO, never repeated Redis polling from the browser.

---

## 18. Failure isolation — `DECIDED`

> **R&D failure must not become a trading failure.** This is the real architectural reason R&D is a separate deployment — not tidiness, not fashion. R&D crashes, Live keeps trading.

| Failure             | R&D      | Paper | Live                 |
| ------------------- | -------- | ----- | -------------------- |
| R&D API down        | DOWN     | UP    | UP                   |
| R&D worker down     | DEGRADED | UP    | UP                   |
| R&D Mongo down      | DEGRADED | UP    | UP                   |
| R&D AI down         | DEGRADED | UP    | UP                   |
| Paper worker down   | UP       | DOWN  | UP                   |
| Paper Redis down    | UP       | DOWN  | UP                   |
| Live dashboard down | UP       | UP    | Trading continues    |
| FYERS unavailable   | UP       | UP    | Fail-safe / recovery |
| Live Redis down     | UP       | UP    | Fail-safe            |

---

## 19. Observability, health and readiness — `PROPOSED`

Every environment needs logs, metrics, health checks, readiness checks, error tracking, queue depth, worker health, Mongo latency, Redis latency, Redis command usage, strategy signal counts and risk rejection counts.

Live additionally monitors broker connection, market-data connection, order-update connection, open positions, unreconciled orders, daily loss, drawdown and the kill switch.

> A process being alive does not mean it is ready to trade.

`/health` and `/readiness` are separate. A process can be alive while Redis is unavailable, Mongo is unavailable, the broker socket is disconnected or risk configuration is invalid. Live readiness is stricter than ordinary application health.

---

## 20. F&O and volume quality — `DECIDED`

### 20.1 Lot-aware risk

The Risk Engine must understand instrument, contract, expiry, strike, option type, lot size and tick size.

```
Capital Risk → Risk Quantity → Lot Quantity → Valid Broker Quantity
```

A calculated quantity of 4 is invalid for a 65-lot instrument. Rounding is always **down**. An unknown lot size is a refusal, never an assumption of 1.

For derivative strategies, the analysis instrument and the traded instrument differ: analyse the index, trade the contract.

For Live, authoritative broker margin is preferred where available.

### 20.2 Volume quality

Volume is not meaningful for every instrument. Store `volumeAvailable`, `volumeSource` and `volumeQuality`. Where reliable volume is unavailable, volume-based conclusions are not drawn — this matters most for index-level research.

---

## 21. Notifications — `PROPOSED`

Do not notify per candle. Notify on: new R&D finding, new strategy candidate, historical validation completed, validation failed, paper validation completed, strategy improvement discovered, promotion candidate created, live promotion approved, critical risk event, broker failure, kill switch, weekly report.

---

## 22. Documentation scope boundary — `DECIDED`

Producing architecture documentation and closing repository gaps are separate activities and are never merged.

```
DOCUMENTATION                     NOT DOCUMENTATION
─────────────────────────         ─────────────────────────
Architecture decisions            Gap closure
R&D specification                 Feature implementation
Current-state audit               Refactor
Known gaps                        AI agent build
Dependencies                      Historical ingestion build
Phase ordering                    Trade engine build
Security boundaries
Research rules
Acceptance criteria
```

Two rules follow, and they bind every future edit of these documents:

1. **The tense rule.** Never write "historical ingestion will be implemented" or, worse, "the system ingests historical data" about something that does not exist. Write "**Phase 1 implementation target:** introduce historical 5-minute market-data ingestion." Describing future infrastructure in the present tense until everyone forgets which parts are real is the specific failure mode these documents exist to prevent.
2. **Audit the branch, not a snapshot.** Current-state claims are verified against the working branch at the moment of writing. A ZIP export, a stale clone or a previous conversation is not evidence.

---

## 23. Non-negotiable rules — `DECIDED`

1. One monorepo.
2. Shared typed contracts.
3. Modular Trading Core.
4. R&D independently deployable.
5. Paper isolated.
6. Live isolated.
7. R&D has no live broker credentials.
8. Paper has no live broker credentials.
9. AI cannot directly place orders.
10. Strategy cannot bypass the Risk Engine.
11. Frontend performs no trading logic.
12. MongoDB is durable business state.
13. Redis is coordination, queues, temporary state and selected events.
14. Market ticks do not go into Redis by default.
15. Realtime UI uses WebSocket/Socket.IO.
16. Critical cross-boundary events use a durable mechanism.
17. Trading-critical calls stay inside the Trading Core.
18. PaperBroker and FyersBroker implement one contract.
19. The Completed Trade is the canonical outcome primitive.
20. Replay is deterministic.
21. Replay never writes to production trading collections.
22. Counterfactual strategy analysis belongs to R&D.
23. Research evidence carries no accidental short TTL.
24. Strategy metrics always include sample size and risk metrics.
25. Walk-forward validation precedes serious promotion.
26. Live trading requires every safety gate.
27. Services are extracted only for a real operational reason.
28. Reliability outranks feature count.

---

## 24. Mental model for every future feature — `DECIDED`

| Question                                        | Answer                              |
| ----------------------------------------------- | ----------------------------------- |
| Is it trading-critical?                         | Keep it close to the Trading Core.  |
| Is it research or AI-heavy?                     | Keep it in R&D.                     |
| Does it need isolation?                         | Separate environment or deployment. |
| Does it need independent scaling?               | Consider a separate service.        |
| Does it need a different runtime?               | Consider a separate service.        |
| Does it exist because microservices are modern? | Do not split it.                    |

---

## Related documents

- [RND_RESEARCH_SPECIFICATION.md](RND_RESEARCH_SPECIFICATION.md) — the research system and its phased build
- [CURRENT_STATE.md](CURRENT_STATE.md) — what exists today, and every known gap
- [../README.md](../README.md) — documentation index and the `plan/NN` citation bridge
