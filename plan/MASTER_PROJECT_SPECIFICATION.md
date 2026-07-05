# MASTER PROJECT SPECIFICATION
## Neelkanth Trader — Autonomous Algorithmic Trading Platform

> **What this document is.** The top-level index and condensed summary of the entire project book (`docs/00` through `docs/28`). It exists so that any reader — new contributor, AI assistant, reviewer, or the operator six months from now — can load the whole system into their head in one sitting and know exactly where every full specification lives.
>
> **Governance rule (read this first).** This document *summarizes*; the chapters *specify*. Every concept here is a condensation with a pointer to its single home chapter (per the source-of-truth rule, 00 §9). **If this document and a chapter ever disagree, the chapter wins** — and the disagreement is a bug in this file. Never extend the system from this summary alone; always read the home chapter.

---

## 1. The system in one page

An **autonomous, event-driven algorithmic trading platform** for Indian markets (NSE/BSE via FYERS). It ingests a live market feed, runs it through deterministic strategies, validates every decision against a risk gate, executes against an interchangeable broker — **paper first, live later, same pipeline** — tracks positions and P&L in real time, and streams everything to an operator dashboard.

The one sentence that dictates everything else (00 §1):

> **The human is an operator, not a trader.**

The operator configures the machine — creates strategies, sets parameters and risk limits, chooses symbols, enables, starts — then supervises it. There is **no manual BUY button** in the execution flow; the operator's manual powers are *pause* and the *kill switch*. The AI subsystem reads news and adjusts a bounded confidence number; it **never places orders**.

**Build order (28):** Phase 0 foundation → **Phase 1 paper trading** (the proving ground: full pipeline, real data feed, simulated fills, zero capital risk) → **Phase 2 AI assist** (layered on a trusted baseline) → **Phase 3 live** (a one-line broker swap behind a hard gate, capital trickled in).

**Stack (04):** TypeScript/Node · Fastify · Zod · Socket.IO · Redis (Pub/Sub, cache, hot state, BullMQ, sessions, rate limits) · MongoDB · FYERS · React + TanStack Query · pnpm/Turborepo monorepo · Docker + PM2 on a VPS · GitHub Actions CI.

---

## 2. The three load-bearing principles (00 §2)

1. **The pipeline is deterministic.** Same inputs → same decision, every time, no step skipped under load. This is what makes an autonomous money-mover auditable, testable (golden runs, 27 §4), and what makes paper trading a faithful rehearsal.
2. **Risk validation runs *before* execution — always.** `Signal → Risk → Broker → Position → PnL`, never `Signal → Broker → Risk`. A risk check after submission is a post-mortem; rejection is only free before execution (14 §2).
3. **The dashboard is a control center, not a trading screen.** Its verbs are configure, monitor, pause, kill. Interface design shapes behavior; making manual execution prominent would undermine the tested, risk-controlled autonomous system (06 §2).

---

## 3. The system flow

```mermaid
flowchart TD
    EX["Exchange NSE/BSE"] --> WS["FYERS WebSocket"]
    WS --> MDE["Market Data Engine (17)"]
    MDE --> RPS[("Redis Pub/Sub (08)")]
    RPS --> IND["Indicator Engine (18)"]
    IND --> MCB["Market Context Builder (15)"]
    NEWS["News API"] --> AI["AI Engine (20)"] -.bounded confidence.-> MCB
    MCB --> STR["Strategy Engines (15/16)"]
    STR --> SIG["Signal: BUY/SELL/HOLD + confidence"]
    SIG -->|synchronous| RISK{"Risk Engine (14)"}
    RISK -- blocked --> LOG["risk_logs + RISK_BLOCKED"]
    RISK -- approved -->|synchronous| OM["Order Manager (12)"]
    OM --> BRK["Broker interface (19): Paper (11) or FYERS"]
    BRK -->|fill| PROJ["Position → Portfolio → PnL (13)"]
    PROJ --> DB[("MongoDB (07)")]
    PROJ --> RPS2[("Redis events (09)")] --> SOCK["Socket.IO (10)"] --> DASH["Dashboard (06)"]
    OP["Operator"] -->|configure / enable| STR
    OP -->|pause / KILL| OM
```

**The two communication regimes (02 §6) — the single most important architectural fact:** from signal to broker submission the path is **synchronous in-process** (so duplicate/exposure checks are atomic with placement — a queue there would reopen the race the Risk Engine exists to close); from confirmed fill onward everything is **event-driven projection** (many independent consumers, none able to stall trading). The asymmetry is deliberate; "unifying" it is a forbidden refactor (26 §3.1).

**The seven planes (02 §4):** Data (17, 18) · Intelligence (20) · Decision (14, 15, 16) · Execution (11, 12, 13, 19) · Persistence (07) · Messaging backbone (08, 09) · Realtime & presentation (06, 10, 23) — plus the Control plane (the operator) sitting *above* the pipeline, never inside it.

---

## 4. The seven invariants (02 §11)

Any change weakening one of these is an **architectural regression**, not a feature:

1. **Determinism** — same inputs, same decision; no step skipped under load.
2. **Risk before broker** — `Signal → Risk → Broker`, never reordered, never made asynchronous (14 §2).
3. **One choke point** — every order passes through the Order Manager: one place to observe, one place to stop (12 §2).
4. **Single source of truth** — every piece of state has exactly one owning writer (02 §8); everyone else reads or reacts to events.
5. **Presentation is never in the critical path** — a dead dashboard cannot affect trading (10 §2).
6. **The broker is interchangeable** — the pipeline depends on the `Broker` interface, never on FYERS (19 §2); going live is a composition-root swap (05 §3).
7. **AI advises, never executes** — its entire influence is one clamped, cached, TTL'd number; it has no bus events and no path to execution (20 §2).

---

## 5. Complete chapter index

| # | Chapter | What it specifies |
|---|---|---|
| 00 | Project Overview | The mental model, the three principles, the chapter template, glossary. **Read first.** |
| 01 | Project Philosophy | The values behind operator-not-trader, determinism, AI-as-advisor — argued as principles. |
| 02 | Master Architecture | Planes, engines, the two regimes, state ownership, concurrency, failure/kill, **the invariants**. |
| 03 | Monorepo Structure | apps/ + packages/ layout; one-way dependencies; one-owner-per-external-system. |
| 04 | Tech Stack | Every technology with its why and its rejected alternative. |
| 05 | Backend Architecture | The composition root (broker selection); the control-plane request lifecycle + endpoint catalog; error handling. |
| 06 | Frontend Architecture | The control center: rendering pipeline, REST-vs-socket split, honest staleness. |
| 07 | Database Design | All **14 collections**: purpose, why, fields, indexes, relationships, lifecycle, retention. |
| 08 | Redis Architecture | The **6 roles** + `risk:` counters; namespaces; durability-per-namespace; fail behavior. |
| 09 | Event-Driven System | The **14-event catalog**: producer/consumers/trigger/payload/retry/logging; idempotency mandate. |
| 10 | WebSocket System | The Socket.IO bridge: rooms, handshake auth, throttling, resync-on-reconnect. |
| 11 | Paper Trading Engine | The PaperBroker: real prices, simulated fills, slippage + full Indian charge stack. |
| 12 | Order Engine | The choke point: kill gate, persist-first, state machine, signalId backstop, never-blind-retry. |
| 13 | Position Engine | Position/Portfolio/PnL math; idempotent fills; realized-vs-unrealized; EOD reconcile. |
| 14 | Risk Engine | The ordering proof; the **4 checks**; entry/exit asymmetry; fail-closed; both-ways logging. |
| 15 | Strategy Engine | The Strategy contract (pure `analyze`); context builder; the full lifecycle; exit watcher; confidence. |
| 16 | Strategy Library | **8 strategies**, each with the 11-attribute mathematical template incl. honest weaknesses. |
| 17 | Market Data Engine | Normalization boundary; candle aggregation; session manager; subscriptions; silent-feed detection. |
| 18 | Indicator Engine | Centralized incremental folds; warm-up + readiness gating; session-anchored resets. |
| 19 | Broker Integration | The `Broker` interface; FYERS auth/daily tokens; client-order-reference; reconnect; rate budget. |
| 20 | AI Engine | News→sentiment→confidence as queued jobs; the hallucination firewall; **fail-neutral**. |
| 21 | Authentication | Two identities; sessions-over-JWT (revocability); httpOnly cookies; step-up on dangerous actions. |
| 22 | Deployment | PC→GitHub→CI→Docker→VPS→PM2; **deploy outside market hours**; graceful shutdown; rollback; backups. |
| 23 | Monitoring | Audit vs telemetry; health model; the metric set (event-loop lag); alert tiers; restore rehearsal. |
| 24 | Security | Threat model (4 assets); 5 defense layers; token encryption + key separation; halt-first. |
| 25 | Coding Standards | Type/naming/boundary/error/async law; docs-move-with-code; the review checklist. |
| 26 | AI Assistant Rules | Rule 0 (read first); the **8-item never list**; scope discipline; escalation; quick card. |
| 27 | Testing | The pyramid; **golden-run determinism tests**; exhaustive-risk policy; failure injection. |
| 28 | Roadmap | Phases 0–3 with explicit exit gates; the go-live checklist; trickle capital discipline. |
| — | `.env.example` | Every environment variable: what/where/why; the env-vs-database config rule. |
| — | This document | Index + summary; governed by the chapters. |

---

## 6. Reading paths by role

- **New contributor:** 00 → 01 → 02, then the full order in 00 §8 (foundations → trading core → data/intelligence → ops).
- **AI assistant (Claude Code):** 26 **first** — its Rule 0 then routes you to 00, 02, and the owning chapter of whatever you're touching. The never list (26 §3) and quick card (26 §8) are your standing constraints.
- **Operator learning the machine:** 00 → 06 (your control surface) → 16 §9 (which strategies suit which regimes) → 14 (what the gate will and won't allow) → 28 (where the project is going).
- **PR reviewer:** 25 §8 (the checklist) with 02 §11 (what it protects) open beside the diff; golden-run diffs are trade diffs (27 §4).
- **Security reviewer:** 24 (threat model + layers) → 21 → 19 §3/§8 → 22 §5 → the structural controls recap in 24 §7.
- **Preparing go-live:** 28 §5 — the gate checklist — and every chapter it cites.

---

## 7. Key decisions record

Each row: the decision, the one-line why, and where the full argument lives. (The rejected alternative is recorded in the home chapter.)

| Decision | Why (one line) | Home |
|---|---|---|
| Sync critical path / async projection split | Duplicate & exposure checks must be atomic with placement; projections must never stall trading. | 02 §6 |
| Single choke point (Order Manager) | One road to the broker ⇒ one audit stream, one kill gate, one place to be careful. | 12 §2 |
| Kill gate at the choke point, flag **persisted** | One flag stops everything; a restart never silently resumes a killed system. | 12 §4, 07 |
| Monorepo (pnpm + Turborepo) | Shared Zod shapes make domain changes one atomic, type-checked commit. | 03 §2 |
| Zod-first, types inferred | One definition = runtime guard + compile-time type; boundary validates once, everything after trusts. | 04 §4, 05 §4 |
| MongoDB (over Postgres) | Flexible evolving shapes + tick throughput; money-consistency is carried **in-process**, not by DB transactions — a recorded, revisitable trade-off. | 04 §7, 07 §7 |
| Redis as one nervous system (6 roles) | Every role needs sub-ms access; namespaces map durability to criticality. | 08 |
| Broker behind an interface; paper = real feed + simulated fills | Going live is a swap; paper P&L is honest because prices are real and slippage/charges are modeled. | 19 §2, 11 §2 |
| Persist-first, then submit; never blind-retry unknowns | Crash recovery needs a durable "may exist at broker" record; blind retry = double execution. | 12 §4, §8 |
| Client order reference on every order | The key that makes reconcile-then-decide possible at the broker. | 19 §5 |
| Daily-loss keyed on **realized** PnL | Booked facts consume the budget; unrealized is a condition that may reverse. | 14 §4.3, 13 §5 |
| Entry/exit asymmetry at limits | When limits breach, the machine may still get *out* — never *into* — positions. | 14 §5 |
| Decisions on **closed candles** | In-progress bars flicker; closed-bar analysis is reproducible and backtestable. | 15 §4 |
| Warm-up + readiness gating | Young recursive indicators are confidently wrong; absence is honest, a bad number is not. | 18 §4 |
| Honest-absence rule (no fabricated prices/bars/fills) | Invented data corrupts P&L and decisions undetectably. | 11 §9, 17 §5 |
| Fail-**closed** risk vs fail-**neutral** AI | Each failure defaults to the safe side of *its own* job: gate blocks, advisor vanishes. | 14 §9, 20 §4 |
| Sessions over JWT; httpOnly cookies | Immediate revocability outranks statelessness when a leaked session can re-enable a killed system. | 21 §4 |
| Step-up confirmation on dangerous actions | A hijacked cookie alone can't re-enable trading or loosen limits. | 21 §5 |
| Deploy outside market hours, period | Recovery machinery exists for failures, not for routine deploys over open positions. | 22 §3 |
| Gates, not dates, on the roadmap | Dates pressure shipping past problems; gates pressure solving them. | 28 §1 |

---

## 8. Data model at a glance (07)

14 collections. Append-only ⇒ audit-grade, never updated after write.

| Collection | Essence | Nature |
|---|---|---|
| `users` | Operator accounts (argon2id hashes; created by bootstrap CLI, no signup route). | mutable, soft-delete |
| `strategies` | Operator's strategy configs + enabled state — *what the machine should run*. | mutable (owner: Strategy Engine) |
| `signals` | Every decision, incl. HOLD/rejected, with `contextSnapshot` — the decision log. | **append-only** |
| `orders` | Every order + outcome; `mode: paper/live`; unique `signalId` backstop. | terminal-immutable |
| `positions` | Holdings + realized/unrealized basis. | mutable (owner: Position Engine) |
| `pnl_snapshots` | EOD PnL per scope — the durable equity curve. | **append-only**, long retention |
| `market_ticks` | Raw tick firehose. | append-only, **short TTL** |
| `candles` | OHLCV bars — indicator warm-up + backtests. | append-only, **long retention** |
| `trade_logs` | Human-readable pipeline narrative. | append-only, TTL |
| `risk_logs` | Every risk decision, **approvals and blocks**, with per-check values. | **append-only** |
| `notifications` | Operator alerts (tiered, 23 §6). | mutable read-flag, TTL |
| `news` | Raw news + AI summary/sentiment — provenance of every nudge. | append-only, TTL |
| `broker_tokens` | FYERS tokens, **AES-256-GCM encrypted at rest**. | rotated by job |
| `settings` | Capital, global risk limits, market hours, **the persisted kill flag**. | mutable via control plane only |

The standing split: **hot, per-decision state lives in Redis; the durable record lives in Mongo** (07 §2, 08 §5).

---

## 9. Event catalog at a glance (09)

14 events on `events:*` / `market:*` channels; typed payloads in `contracts`; **broadcasts are not retried — recovery is resync, so consumers must be idempotent** (09 §4–5).

| Event | Producer → key consumers |
|---|---|
| `MARKET_TICK` | Market Data → Indicators, dashboard (throttled) |
| `CANDLE_CLOSED` | Market Data → Indicators, **Strategy Engine (the heartbeat)** |
| `INDICATORS_UPDATED` | Indicators → Context/Strategy |
| `SIGNAL_CREATED` | Strategy → dashboard, logger *(Risk is called synchronously, not via this event)* |
| `RISK_BLOCKED` | Risk → dashboard, notifications |
| `ORDER_PLACED` / `ORDER_FILLED` | Order Manager → dashboard / **Position Engine (starts the projection chain)** |
| `POSITION_UPDATED` | Position → Portfolio, PnL, dashboard |
| `PNL_UPDATED` | PnL → dashboard, **Risk (daily-loss counter)** |
| `BROKER_CONNECTED` / `BROKER_DISCONNECTED` | Broker → pipeline / **Order Manager halts new orders** |
| `MARKET_OPEN` / `MARKET_CLOSE` | Session mgr → Strategy gating / EOD reconcile |
| `SYSTEM_ERROR` | any → monitoring, dashboard — *nothing fails silently* |

---

## 10. State ownership at a glance (02 §8)

**If you don't own it, you don't write it** — call the owner or emit an event.

| Truth | Sole writer |
|---|---|
| Prices, candles, session | Market Data Engine |
| Indicator values | Indicator Engine |
| Strategy config, signals | Strategy Engine |
| Risk counters (`risk:*`), risk_logs | Risk Engine |
| Orders | Order Manager |
| Positions / portfolio / PnL | Position–Portfolio–PnL chain |
| Broker tokens | Broker/auth layer |
| Settings (incl. kill flag) | Control plane (operator; auto-pause routes through it) |
| News + sentiment cache | AI Engine |

---

## 11. Strategy library at a glance (16)

Eight strategies, each fully specified with the 11-attribute template (formula, inputs, outputs, buy/sell, SL, target, strengths, weaknesses, suitable/unsuitable market). All are pure `analyze(context) → Signal` implementations (15 §2); all decide on closed candles; all attach SL/target enforced by the engine's exit watcher through the same risk-gated pipeline (15 §5).

| Strategy | Family | Signal essence |
|---|---|---|
| OHL | Open sentiment | First candle O=L ⇒ buy / O=H ⇒ sell |
| EMA Crossover | Trend | fast(9) × slow(21) cross |
| RSI | Mean reversion | re-cross up through 30 / down through 70 |
| VWAP | Bias + pullback | hold above VWAP, buy the defended pullback |
| ORB | Breakout | close beyond the first-15-min range |
| Gap Up | Gap continuation | qualifying gap + hold above open + first-candle-high break on volume |
| SuperTrend | Trend + trailing stop | ATR-band flip; the line *is* the stop |
| Volume Breakout | Participation breakout | N-bar high break **gated** on ≥k× average volume |

**The regime rule (16 §9):** no strategy is universal — trend tools whipsaw in ranges, mean-reversion loses in trends, gaps fill. The operator enables the regime-appropriate subset; the honest Weaknesses sections double as each strategy's test plan (27 §3).

---

## 12. Operations digest

- **Deploy:** CI-gated, SHA-tagged images, **never during market hours**; graceful shutdown drains in-flight broker calls; boot reconciles stale `PLACED/PENDING` orders and honors the persisted kill flag before trading resumes (22 §3–4).
- **Health:** liveness ("restart me?") vs readiness ("trust me?"); **event-loop lag is the architecture's canary metric** (23 §4–5).
- **Alerts are tiered by required action** — act-now (broker down in session, loss at 80% of limit, unreconciled order), act-today (token refresh failing, backup failed), awareness (23 §6).
- **Backups:** Mongo dumps off-box daily; Redis AOF for durable namespaces only; **restore rehearsed quarterly** — a backup never restored is a theory (22 §6, 23 §7).
- **Incidents:** the standing rule is **halt first** — a stopped system loses opportunity; a compromised running one loses money (24 §8).

---

## 13. Contributor digest

- **Code law (25):** strict TS, no `any`; Zod-first inferred types; events/keys via `contracts`/builders only (a typo'd literal fails silently — builders make it a compile error); typed errors, no swallowed catches, no floating promises, nothing blocking on the hot path; no magic numbers; **docs updated in the same PR**.
- **AI contributors (26):** read 00 + 02 + the owning chapter first; the **never list** — never de-synchronize the critical path, never bypass the Order Manager, never give the AI Engine reach, never cross-write owned state, never add manual-trade UI as primary, never flip a fail-safe's direction, never handle secrets casually, never fabricate data. Unsure, or brushing risk semantics / live paths / audit trails → **stop and ask**.
- **Testing bar (27):** logic proven at unit speed (pure folds/`analyze`/math); risk checks **exhaustive by policy** incl. the asymmetry and fail-closed; idempotent double-fill test; failure-injection for every recovery promise; **golden runs turn determinism into CI** — an intended behavior change appears in review as a diff of trades.

---

## 14. Roadmap & gates (28, condensed)

- **Phase 0 — Foundation.** Monorepo, schemas, config fail-fast, infra packages, CI, health. *Gate:* boots strictly, CI red-blocks, dependency cycles fail the build.
- **Phase 1 — Paper (the proving ground).** Full pipeline vs. PaperBroker; 2–3 strategies harden the plumbing, then all eight. *Gate:* golden runs + failure injection green; **~20 consecutive clean live-market paper sessions** (zero reconcile divergence, zero unreconciled orders); **kill drill** incl. restart-still-halted; token job survives real mornings; **restore rehearsal done**; per-strategy P&L behaves as Chapter 16 documents — including losing where the book says it loses.
- **Phase 2 — AI assist.** News→sentiment→confidence on the trusted baseline. *Gate:* **fail-neutral proven by test and drill** (AI absent ⇒ Phase-1-identical behavior); firewall green; every nudge traceable to stored news; evaluation loop accumulating before any bound widens.
- **Phase 3 — Live (the gated swap).** FYERS execution side + **bracket orders first** (broker-side SL survives our process dying) + 2FA + staging chaos/reconciliation drills. *Gate:* every box in 28 §5. *Then:* `BROKER_MODE=live` — one strategy, one symbol, small dedicated capital, limits stricter than paper, widened only on clean sessions as logged operator decisions.
- **The governing rule:** no phase skipped, no gate waived — each phase introduces exactly **one new dimension of reality**, so any new failure has one place to look (28 §8).

---

## 15. Configuration

Environment = **infrastructure identity + secrets** (validated at boot, refuse-to-start on failure); the database = **trading behavior** the operator tunes at runtime with an audit trail. Every variable — what it is, where to obtain it, generation commands, dev-vs-prod values, and what deliberately *isn't* env (daily FYERS tokens, risk limits, the kill flag) — is documented inline in **`.env.example`**.

---

## 16. Glossary & conventions

Core vocabulary (operator, tick, candle, context, signal, confidence, kill switch, …) is defined once in **00 §10**. Every subsystem chapter follows the nine-section template in **00 §9**; every concept has exactly one home chapter; this document is the index that proves the rule.

---

*This specification is complete when it sends you to the right chapter in under a minute. For everything else — the chapter wins.*
