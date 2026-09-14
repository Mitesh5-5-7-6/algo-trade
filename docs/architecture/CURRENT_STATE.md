# Current State — Neelkanth Trader

**Status:** Audit baseline — Phase 0 re-verification applied
**Audited against:** branch `docs/architecture-baseline`, working tree, 2026-09-14
**Governed by:** [ARCHITECTURE_DECISION.md](ARCHITECTURE_DECISION.md)

This document records what the repository actually contains, as opposed to what the architecture describes. It exists because the two architecture documents are forward-looking by design, and a plan that quietly assumes unbuilt infrastructure is worse than no plan.

Every gap below is recorded, not fixed, **except** the one Phase 0 owns: the session flush (§5.1), which is repaired and marked so. Everything else remains an entry, not a task.

### Component status vocabulary

| Status             | Meaning                                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| `EXISTS`           | Present, wired, and behaving as intended                                    |
| `PARTIALLY EXISTS` | Present and working, but materially narrower than the architecture requires |
| `BROKEN`           | Present and wired, but does not do what it appears to do                    |
| `MISSING`          | Not present in any form                                                     |

`BROKEN` is a distinct category on purpose. The components in §5 were each constructed, referenced and covered by tests, and still did not work in production. One of them — the session flush — is now repaired; four remain.

### Audit rule

Every claim here is verified against the **working branch** at the time of writing. A ZIP export, a stale clone or a prior conversation is not evidence. This rule exists because `packages/engines/src/exit/` was previously believed absent from a snapshot while being present and wired in the repository.

---

## 1. Summary

| Gap                                     | Status             | Phase |
| --------------------------------------- | ------------------ | ----- |
| Historical 5m ingestion                 | `MISSING`          | 1     |
| Date-range candle query                 | `EXISTS` ✅        | 1     |
| Candle provenance                       | `EXISTS` ✅        | 1     |
| Completed Trade entity                  | `MISSING`          | 2     |
| Entry ↔ exit linkage                    | `MISSING`          | 2     |
| Exit lifecycle completeness             | `PARTIALLY EXISTS` | 3     |
| Session flush / `pollSession`           | `EXISTS` ✅        | 0     |
| Flush depends on a correct holiday list | `MISSING` guard    | —     |
| Daily-loss restart persistence          | `BROKEN`           | 0–3   |
| Deterministic replay coverage           | `PARTIALLY EXISTS` | 4     |
| Pattern vocabulary                      | `MISSING`          | 5     |
| Statistical gate                        | `MISSING`          | 7     |
| Daily R&D                               | `MISSING`          | 8     |
| AI research agent                       | `MISSING`          | 11    |
| Environment separation (R&D/Paper/Live) | `PARTIALLY EXISTS` | —     |
| Per-strategy PnL snapshots              | `BROKEN`           | —     |
| Signal outcome recording                | `BROKEN`           | —     |
| Daily PnL snapshot durability           | `BROKEN`           | —     |

Phase numbers refer to [RND_RESEARCH_SPECIFICATION.md §4](RND_RESEARCH_SPECIFICATION.md). Entries with no phase are trading-platform defects rather than research dependencies; they are recorded here because they distort the very evidence the research system is meant to consume.

**✅ The session flush is repaired** — Phase 0, see §5.1. It was a hard prerequisite for Phase 1: backfilling historical candles over a still-broken aggregator creates two data-quality problems in one collection, each masking the other ([../design/PHASE_1_HISTORICAL_DATA.md §1](../design/PHASE_1_HISTORICAL_DATA.md)). That prerequisite is now met. §5.6 records the one residual case the repair deliberately does not cover.

---

## 2. Subsystem status

| Subsystem                          | Status             | Note                                                                 |
| ---------------------------------- | ------------------ | -------------------------------------------------------------------- |
| Market data ingestion (live ticks) | `EXISTS`           | Monotonic guard, per-symbol; ticks deliberately not written to Redis |
| Candle aggregation                 | `PARTIALLY EXISTS` | 2 of 5 supported intervals built at runtime; flushed at close (§5.1) |
| Candle storage                     | `PARTIALLY EXISTS` | Idempotent upsert; no range query, no provenance                     |
| Historical data                    | `MISSING`          | —                                                                    |
| Indicator engine                   | `EXISTS`           | Deterministic, warm-up from stored candles                           |
| Strategy engine                    | `PARTIALLY EXISTS` | 4 of a planned 9 strategies                                          |
| Risk engine                        | `EXISTS`           | Five checks, fail-closed, risk-reducing exemption                    |
| Order manager                      | `EXISTS`           | Unique `signalId` index as the duplicate-execution backstop          |
| Position engine                    | `EXISTS`           | Fill projection, idempotent, reversal-aware                          |
| Exit engine                        | `PARTIALLY EXISTS` | Three triggers                                                       |
| Trade entity                       | `MISSING`          | —                                                                    |
| PnL                                | `PARTIALLY EXISTS` | Global scope works; per-strategy is empty                            |
| Broker abstraction                 | `EXISTS`           | One contract, three implementations                                  |
| Event bus                          | `EXISTS`           | In-process by default; Redis path present but unused                 |
| Deterministic replay               | `PARTIALLY EXISTS` | Real harness, narrower machine, synthetic fixture only               |
| R&D platform                       | `MISSING`          | —                                                                    |
| AI / RAG                           | `MISSING`          | —                                                                    |

---

## 3. The blocking chain

These five gaps are strictly sequential. Nothing in the R&D specification can begin before the first is closed.

**Progress:** §3.2 and §3.3 are closed — the storage and provenance foundation, which depends on nothing the broker has to tell us. §3.1 remains open and is blocked on the vendor questions in [../design/PHASE_1_HISTORICAL_DATA.md §10.1](../design/PHASE_1_HISTORICAL_DATA.md), not on engineering.

### 3.1 Historical 5-minute ingestion

- **Current state:** `MISSING`. Candles can only ever originate from live ticks.
- **Evidence:** The `Broker` interface ([packages/broker/src/broker.ts](../../packages/broker/src/broker.ts)) declares nine methods — `execute`, `cancel`, `status`, `onOrderUpdate`, `connect`, `disconnect`, `subscribe`, `onData`, `onConnectionChange` — and no history method. [packages/broker/src/fyers-broker.ts](../../packages/broker/src/fyers-broker.ts) makes three REST calls, all order-related; there is no `/data/history` call anywhere in the repository.
- **Why it matters:** Every phase from 1 onward consumes historical candles. Without this, the research system has no input at all, and "analyse one historical trading day" is not an executable instruction.
- **Dependencies:** None. This is the root of the chain.
- **Planned phase:** 1.
- **Out of scope for the documentation task.**

### 3.2 Date-range candle query — CLOSED

- **Original state:** `MISSING`. The repository exposed only `upsert` and `loadRecent(limit)`, so a replay harness could not ask for "a trading day" — `loadRecent` answers "the last N bars", which is the wrong question for research.
- **Fix:** `CandlesRepository.findRange(symbol, interval, fromTs, toTs)` ([candles-repository.ts](../../packages/db/src/candles-repository.ts)), half-open `[from, to)` so consecutive day requests tile exactly. Served by the existing unique index `{symbol, interval, ts}` — equality prefix plus range — so no new index.
- **Status:** `EXISTS`. Design D4.

### 3.3 Candle provenance — CLOSED

- **Original state:** `MISSING`. `CandleSchema` was `{symbol, interval, open, high, low, close, volume, ts}` — no `source`, no ingestion version — so a broker-fetched bar and a tick-aggregated bar were indistinguishable, and the idempotent upsert meant one silently overwrote the other. Closing 3.1 first would have actively created that problem, against [ARCHITECTURE_DECISION.md §7](ARCHITECTURE_DECISION.md)'s rule that data sources are never silently mixed.
- **Fix:** `CandleSourceSchema` (`LIVE_TICK` / `BROKER_HISTORICAL` / `REPLAY` / `IMPORTED_DATA`) plus `ingestedAt` and `ingestionVersion` ([market.ts](../../packages/core/src/market.ts)). `source` is **defaulted**, not required, so every bar already in Mongo still parses — a required field would have thrown on the first indicator warm-up after deploy. On the TypeScript output type it is required, so every producer must declare provenance; the aggregator stamps `LIVE_TICK`, the only thing it can produce.
- **Precedence:** `CANDLE_SOURCE_RANK` plus a conditional upsert means a write can never demote the stored bar — the broker's record overwrites ours, ours never overwrites the broker's ([candles-repository.ts](../../packages/db/src/candles-repository.ts)). Legacy bars carry no `sourceRank`, and in Mongo a missing field does not match `$lte`, so absence is treated as `LIVE_TICK` rather than falling through to an insert the unique index would refuse.
- **Status:** `EXISTS`. Design D2 and D3.

### 3.4 Completed Trade entity

- **Current state:** `MISSING`.
- **Evidence:** `trade_logs` is declared in the collection registry, given three indexes and a 90-day TTL ([packages/db/src/collections.ts](../../packages/db/src/collections.ts)), and is **never read or written**. There is no `Trade` schema, no `TradeLogsRepository`, no insert site and no `/trades` route. A repository-wide search for `tradeLogs` returns only `collections.ts`.
- **Why it matters:** This is the canonical outcome primitive named in [ARCHITECTURE_DECISION.md §9.2](ARCHITECTURE_DECISION.md). Without it, research has no labels: a signal is not an outcome and an entry is not an outcome. It is also why the platform cannot currently answer what any individual decision earned.
- **Dependencies:** Needs 3.5 to be meaningful.
- **Planned phase:** 2.
- **Out of scope for the documentation task.**

### 3.5 Entry ↔ exit linkage

- **Current state:** `MISSING`.
- **Evidence:** The persisted `Position` ([packages/core/src/position.ts](../../packages/core/src/position.ts)) carries no `entryOrderId`, `exitOrderId`, `exitReason`, `charges` or `slippage`. `Order` ([packages/core/src/order.ts](../../packages/core/src/order.ts)) carries `signalId` but no `positionId` — so the order/position edge exists in neither direction. `ORDER_FILLED` carries `slippage`, and the position engine consumes only `charges`, folding them irreversibly into `realizedPnl`; `slippage` is discarded.
- **Why it matters:** Reconstructing "what did this trade make, and why did it end?" currently requires joining positions to orders with no foreign key and inferring the closing fill from `closedAt`. The links the research chain depends on — `Pattern → Signal → Order → Trade → Outcome` — are inferences, not references.
- **Dependencies:** Prerequisite for 3.4.
- **Planned phase:** 2.
- **Out of scope for the documentation task.**

---

## 4. Partially exists

### 4.1 Exit engine

- **Current state:** `PARTIALLY EXISTS`. Present, wired and live.
- **Evidence:** [packages/engines/src/exit/exit-engine.ts](../../packages/engines/src/exit/exit-engine.ts) with ports in the same directory. `ExitTrigger = "stop" | "target" | "square_off"` — three triggers. Constructed at [apps/api/src/engines/runtime.ts:551](../../apps/api/src/engines/runtime.ts#L551); `onCandleClosed` is called at line 648 **before** market-bias refresh and indicator update, so protective exits are judged before new entries on the same bar. Exits route through the same risk → order handoff as strategy signals and are exempted from the market-bias, daily-loss and position-size gates as risk-reducing.
- **Gap:** No strategy exit, no time-in-trade exit, no trailing stop, no partial exit or scale-out. A strategy currently has no way to say "close this" — an exit only happens if it emits an opposite-side signal that the position engine nets against. The in-memory `exiting` guard is not persisted, so a restart between handoff and fill permits a re-exit.
- **Why it matters:** [RND_RESEARCH_SPECIFICATION.md §4](RND_RESEARCH_SPECIFICATION.md) Phase 3 requires that every simulated entry can reach an outcome. Three triggers cover most but not all entries.
- **Planned phase:** 3.
- **Note:** This component was previously believed absent from a ZIP snapshot. It is present. The audit rule at the top of this document exists because of that.

### 4.2 Deterministic replay coverage

- **Current state:** `PARTIALLY EXISTS`. A genuine replay harness, narrower than production.
- **Evidence:** [apps/api/src/golden/pipeline.ts](../../apps/api/src/golden/pipeline.ts) constructs the real `PositionEngine`, `PnlEngine`, `PaperBroker`, `OrderManager`, `RiskEngine`, `IndicatorEngine` and `StrategyRunner` against in-memory ports, driven by a `GoldenFixture` that is already a parameter rather than a constant. The candle timestamp is the clock; ids are counters; slippage is fixed. No Mongo, no Redis, no writes to production collections.
- **Gap:** Three engines are absent from the harness — `ExitEngine`, `MarketDataEngine`/`CandleAggregator`, and `MarketBiasEngine` (hardcoded to an unknown market view). The fixture is 60 synthetic sine-wave bars for a test symbol, and `readInstrument` / `resolveContract` return null, so the option-momentum strategy cannot be replayed at all. There is no CLI or route that invokes it outside the test.
- **Why it matters:** The determinism proof covers a strictly smaller machine than production — in particular, a machine with no exits, which is the machine least able to produce outcomes.
- **Planned phase:** 4. The architecture requires parameterising this harness rather than building a second replay engine.

### 4.3 Environment separation

- **Current state:** `PARTIALLY EXISTS`.
- **Evidence:** One axis only — `BROKER_MODE=paper|live` ([packages/config/src/index.ts](../../packages/config/src/index.ts)), stamped onto orders and positions as `mode`. No `APP_ENV`, no `PAPER_TRADING_ENABLED`, no `LIVE_TRADING_ENABLED`, no `BROKER_ORDER_ENABLED`. One Mongo database ([packages/db/src/client.ts](../../packages/db/src/client.ts)), one Redis URL with four connections, and **no environment component in any Redis key** ([packages/redis/src/keys.ts](../../packages/redis/src/keys.ts)). In paper mode with FYERS credentials present, [apps/api/src/composition-root.ts](../../apps/api/src/composition-root.ts) builds a deliberate hybrid: live FYERS market data spliced onto paper execution — which is why `mode` is injected explicitly and must never be inferred from the wired broker object.
- **Why it matters:** [ARCHITECTURE_DECISION.md §8](ARCHITECTURE_DECISION.md) requires separate databases and separate Redis instances per environment. Today paper and live rows share collections, separated only by a field.
- **Planned phase:** Not a research dependency; sequenced with the first R&D deployment.

### 4.4 Strategy and interval coverage

- **Current state:** `PARTIALLY EXISTS`. Four strategies of a planned nine — `EMA_CROSSOVER`, `RSI`, `ORB`, `INDEX_OPTION_MOMENTUM` ([packages/strategies/src/index.ts](../../packages/strategies/src/index.ts)). Two candle intervals of five supported — `MARKET_INTERVALS = ["1m", "5m"]` ([apps/api/src/engines/runtime.ts:89](../../apps/api/src/engines/runtime.ts#L89)).
- **Why it matters:** Counterfactual evaluation (Phase 6) compares strategies against one another. Four is enough to start and is worth noting when reading any comparison table.

---

## 5. Broken

Each of these was constructed, referenced, and did not do what its presence implies. §5.1 is repaired; §5.2–5.5 stand. §5.6 is a new finding from the Phase 0 repair.

### 5.1 Session flush never ran — FIXED in Phase 0

- **Original evidence:** `MarketDataEngine.pollSession()` was called only from within its own module and its unit test. Production never called it — the runtime evaluates session state through its own `SessionManager` on a 15-second timer and publishes the open/close events itself.
- **Correction to the original entry.** The first pass recorded this as "each session's final partial bar is never persisted". That was imprecise in a way that understated one risk and overstated another. What actually happened:
  - The bar stayed open in the aggregator. The **next session's first tick** pushed the bucket forward, which finalised and persisted it — carrying _yesterday's_ timestamp.
  - So it was lost outright only when the process restarted overnight. Otherwise it was persisted roughly seventeen hours late.
  - And on that late path it was also **published as `CANDLE_CLOSED` into a live, open market**. The runtime's handler feeds every closed bar to `exitEngine.onCandleClosed` — which judges stops and targets against it — as well as to `lastPrices`, the indicator engine and the strategy runner. A day-old bar arriving at 09:15 is not a stale cache entry; it is a trading input.
- **Why it mattered for research:** the dataset would have been missing its last bar of every session in which the process restarted, and would otherwise carry bars whose persistence order does not match their session.
- **Root cause:** two session drivers. The engine held a `SessionManager` — the runtime injected _its own instance_ — and `SessionManager.evaluate()` consumes the open/close edge. Had anything ever called `pollSession`, it would have eaten the transition the runtime's `MARKET_OPEN`/`MARKET_CLOSE` publishing depends on, and those events would have stopped silently.
- **Fix:** `MarketDataEngine.flushOpenBars()` persists and publishes every open bar and holds no session state. The runtime calls it inside the `marketClosed` branch of `syncSession`, before publishing `MARKET_CLOSE` and before the PnL snapshot. The dead `pollSession`, and the now-unused `session` and `exchange` dependencies, are removed — one session driver, no shared stateful manager. See [market-data-engine.ts](../../packages/engines/src/market-data/market-data-engine.ts) and [runtime.ts](../../apps/api/src/engines/runtime.ts).
- **Status:** `EXISTS`. Six tests cover flush, multi-symbol/multi-interval flush, idempotency, the empty case, error routing, and the absence of a second session driver.

### 5.2 Daily-loss counter resets on restart

- **Evidence:** `readDailyRealizedLoss` reads in-memory state — `Math.max(0, -positionEngine.realizedPnl())` ([apps/api/src/engines/runtime.ts:440](../../apps/api/src/engines/runtime.ts#L440)) — and that counter is zeroed on market open.
- **Consequence:** A mid-session process restart makes the daily-loss gate forget the day's losses entirely.
- **Why it matters:** This is a live risk control, not a reporting detail.
- **Planned phase:** 0–3.

### 5.3 Per-strategy PnL snapshots are structurally empty

- **Evidence:** The runtime supplies `byStrategy: new Map()` to `getRealized()` ([apps/api/src/engines/runtime.ts:366](../../apps/api/src/engines/runtime.ts#L366)) despite `realizedPnlForStrategy()` existing on the position engine.
- **Consequence:** Per-strategy snapshot rows are written with empty values. Only the global scope is populated.
- **Why it matters:** Per-strategy history is exactly what strategy comparison research needs.

### 5.4 Daily PnL snapshot is not durable

- **Evidence:** `pnl.snapshot()` fires only on the market-closed transition inside the 15-second session sync.
- **Consequence:** If the process is not running at 15:30 IST, that trading day's snapshot row is never written, and nothing backfills it.

### 5.5 Signal outcomes are never recorded

- **Evidence:** `SignalSchema` declares `outcome` and `rejectReason`, and [packages/db/src/signals-repository.ts](../../packages/db/src/signals-repository.ts) exposes `insert` plus four read methods — there is no update path. Risk decisions land in a separate `risk_logs` collection, joinable only by `signalId`.
- **Consequence:** The signal record never learns what happened to it.
- **Why it matters:** `Signal → Outcome` is a link in the research chain in [RND_RESEARCH_SPECIFICATION.md §6.2](RND_RESEARCH_SPECIFICATION.md).

### 5.6 New finding — the flush depends on a correct session calendar

Found while repairing §5.1, and deliberately **not** fixed with it.

- **Evidence:** `ingestRaw` ([market-data-engine.ts](../../packages/engines/src/market-data/market-data-engine.ts)) has no session gate — it aggregates whatever the feed delivers, whenever it arrives. The flush is driven by `evaluation.marketClosed`, which fires only on a genuine open→closed transition.
- **Consequence:** on a day the settings' `marketHolidays` wrongly marks as a holiday, `SessionManager` reports `closed` all day, so there is no open→closed edge and no flush — while ticks still aggregate normally. The §5.1 carry-over returns for exactly that day.
- **Why it is narrow:** it requires the holiday list to disagree with the exchange. A genuinely closed exchange sends no ticks, so nothing accumulates.
- **Why it is real:** the holiday list is hand-maintained in the global settings document, and a wrong entry is silent in both directions.
- **Status:** `MISSING` guard, recorded not fixed. Widening the Phase 0 repair to cover it would mean adding a session gate to the tick path — a behaviour change to live ingestion, which is outside the scope fence in [RND_RESEARCH_SPECIFICATION.md Phase 0](RND_RESEARCH_SPECIFICATION.md).
- **Planned phase:** unscheduled. Candidates when it is taken up: gate `ingestRaw` on session phase, or make the flush time-driven rather than edge-driven.

---

## 6. Missing R&D subsystems

Recorded for completeness. None of these exist in any form, and each is gated on the blocking chain in §3.

| Subsystem                                  | Phase |
| ------------------------------------------ | ----- |
| Pattern vocabulary and detector versioning | 5     |
| Counterfactual strategy evaluation         | 6     |
| Statistical gate and hypothesis registry   | 7     |
| Daily research records                     | 8     |
| Weekly / monthly / quarterly aggregation   | 9     |
| Research knowledge base                    | 10    |
| AI research agent and tool calling         | 11    |
| RAG / embeddings                           | 11    |
| Backtest and walk-forward validation       | 13    |
| Strategy promotion pipeline                | 15    |

---

## 7. Documentation debt

- **The `plan/` documentation spine was deleted** in commit `c158458`, removing 29 markdown files. Roughly 900 `plan/NN §X` citations remain in source comments, across configuration, broker, Redis keyspace, settings, CI and the root package manifest. These are resolved through the bridge table in [../README.md](../README.md) rather than by editing the comments. The originals remain recoverable from `c158458^`.
- **`task.md`** at the repository root tracks phases derived from the deleted `plan/28_ROADMAP.md` and is now partly orphaned.
- **`ImproveRedis.md`** at the repository root is a live work order on Redis command consumption and remains valid.

---

## 8. Next engineering sequence

```
 0. Verify repo + aggregator integrity
 1. Historical 5m ingestion
 2. Trade entity + lifecycle
 3. Exit lifecycle
 4. Deterministic replay
 5. Pattern vocabulary
 6. Counterfactual strategy evaluation
 7. Statistical validation
 8. Daily R&D
 9. Weekly / monthly / quarterly R&D
10. Research knowledge base
11. AI research agent
```

These are the canonical phase numbers from [RND_RESEARCH_SPECIFICATION.md §4](RND_RESEARCH_SPECIFICATION.md); Phases 12–15 continue past the end of this chain. Everything from Phase 7 onward is downstream of having trustworthy evidence — which is the entire reason this document exists.

The first two steps are not independent. Phase 0 includes repairing the session flush (§5.1), and Phase 1 does not begin until it is repaired.

---

## Related documents

- [ARCHITECTURE_DECISION.md](ARCHITECTURE_DECISION.md) — architectural authority
- [RND_RESEARCH_SPECIFICATION.md](RND_RESEARCH_SPECIFICATION.md) — the research system and its phases
- [../README.md](../README.md) — documentation index and the `plan/NN` citation bridge
