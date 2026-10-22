# Algo Trade Development Plan

> **SINGLE EXECUTION PLAN**
>
> This document is the only document that defines implementation order and the
> next engineering task. See [§29](#29-document-roles) for how it relates to the
> architecture and research specifications.

---

## 1. Mission

Build a reliable algorithmic trading platform where:

```text
Market Data → Candle → Indicator → Strategy → Signal → Risk → Order
→ Broker → Fill → Position → Trade → P&L → Research → AI
```

The system must establish trustworthy trading evidence before introducing AI
research automation.

---

## 2. Non-negotiable rules

1. Strategy never places orders directly.
2. Risk Engine always runs before execution.
3. AI never places broker orders.
4. Frontend never performs trading logic.
5. Paper and Live environments remain isolated.
6. R&D cannot access Live broker credentials.
7. Replay never writes to production trading collections.
8. Historical research must not use future information.
9. Every strategy is versioned.
10. Every completed trade has a complete entry and exit.
11. Research results include sample size and cost assumptions.
12. Live promotion requires explicit approval.
13. Do not refactor unrelated code while implementing a phase.
14. Reuse existing packages/contracts unless a real gap requires change.
15. Do not implement future phases early.

---

## 3. Current architecture

### Trading

```text
Market Data
    ↓
Candle / Indicator
    ↓
Strategy
    ↓
Signal
    ↓
Risk Engine
    ↓
Order Manager
    ↓
Broker
    ↓
Position
    ↓
Trade
    ↓
P&L
```

### R&D

```text
Historical Data
    ↓
Validated Candles
    ↓
Replay
    ↓
Completed Trades
    ↓
Patterns
    ↓
Strategy Evaluation
    ↓
Statistics
    ↓
Research
    ↓
Knowledge Base
    ↓
AI Agent
```

### AI

AI **may**:

```text
READ · ANALYZE · COMPARE · RESEARCH · PROPOSE
REQUEST BACKTEST · REQUEST WALK-FORWARD · CREATE HYPOTHESIS
```

AI **may not**:

```text
PLACE LIVE ORDER · BYPASS RISK · CHANGE KILL SWITCH
CHANGE LIVE LIMITS · APPROVE ITS OWN STRATEGY
```

---

## 4. Development order

The project is executed strictly in this order. No phase is skipped. A later
phase may only start when its dependency is complete.

| Phase | Deliverable                        | STATUS   |
| ----- | ---------------------------------- | -------- |
| 0     | Repository + runtime integrity     | COMPLETE |
| 1     | Historical 5m data                 | COMPLETE |
| 2     | Trade lifecycle                    | COMPLETE |
| 3     | Exit lifecycle                     | COMPLETE |
| 4     | Deterministic replay               | COMPLETE |
| 5     | Pattern vocabulary                 | COMPLETE |
| 6     | Counterfactual strategy evaluation | COMPLETE |
| 7     | Statistical validation             | COMPLETE |
| 8     | Daily research                     | COMPLETE |
| 9     | Periodic research                  | COMPLETE |
| 10    | Research knowledge base            | READY    |
| 11    | AI research agent                  | READY    |
| 12    | Automated strategy hypotheses      | READY    |
| 13    | Backtest + walk-forward            | READY    |
| 14    | Paper validation                   | READY    |
| 15    | Promotion                          | READY    |

**Phase status is derived, never typed.** A phase is `COMPLETE` only when every
one of its tasks is `COMPLETE`; `IN PROGRESS` when any task is `IN PROGRESS` or
`COMPLETE`; otherwise `READY`. **`BLOCKED` is a task-level value with no
phase-level equivalent** — a blocked task must never be readable as a blocked
phase, because that is how "Phase 1 is blocked" becomes "so let us work on
Phase 7".

**`STATUS: COMPLETE` requires an Evidence cell naming a real file.** A completion
claim with nothing behind it is an opinion, and §26 already demands acceptance
evidence. This is where it lands.

> **Some work exists but is not yet landed.** Branch `docs/architecture-baseline`
> carries implemented Phase 1, 2, 4 and 5 work. It is deliberately **not** merged:
> doing so would put later-phase code in a Phase 0 diff, against rules 13 and 15
> and §26. Each phase ports its own part when it starts.

---

## 5. Phase 0 — Repository + runtime integrity

**STATUS: COMPLETE**

### Goal

Verify the real working branch and repair the runtime foundation.

### Tasks

| ID    | Task                                                                                        | STATUS   | Commit    | Evidence                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1   | Inspect repository; verify market data, aggregation and reconciliation                      | COMPLETE | —         | [CURRENT_STATE.md](architecture/CURRENT_STATE.md) §2, §5                                                                                                                  |
| 0.2   | Fix aggregator session flush; persist the final partial candle; no cross-session carry-over | COMPLETE | `6132cec` | `packages/engines/src/market-data/market-data-engine.ts` (`flushOpenBars`), wired in `apps/api/src/engines/runtime.ts`; CURRENT_STATE §5.1                                |
| 0.3   | Defuse the integration-test database landmine                                               | COMPLETE | `781331a` | `apps/api/src/composition-root.integration.test.ts` — `isolate()` plus a module-scope refusal                                                                             |
| 0.4   | Make "existing tests remain green" a provable claim                                         | COMPLETE | `c2525f2` | `packages/db/src/test-support/infra.ts`, `apps/api/src/test-support/infra.ts`, `scripts/test-integration.mjs`, `docker-compose.test.yml`, `turbo.json` `test.env`         |
| 0.5.4 | Daily P&L survives restart                                                                  | COMPLETE | `9c1a9bc` | `packages/engines/src/risk/daily-loss-ledger.ts` + `.test.ts`; `PositionEngine.seedDailyRealized`; CURRENT_STATE §5.2                                                     |
| 0.5.5 | One-shot latch spent by a fill, not an emission                                             | COMPLETE | `9c1a9bc` | `packages/strategies/src/orb.ts`; `packages/engines/src/strategy/signal-outcome.test.ts`; CURRENT_STATE §5.7                                                              |
| 0.5.6 | Strategy state survives restart                                                             | COMPLETE | `9c1a9bc` | `packages/db/src/strategy-state-repository.ts`; `packages/engines/src/strategy/strategy-state.test.ts`; CURRENT_STATE §5.8                                                |
| 0.6   | Cross-session contamination test                                                            | COMPLETE | `74801b8` | `packages/engines/src/market-data/market-data-engine.test.ts` — mutation-checked: emptying `flush()` fails it                                                             |
| 0.7   | Risk gate fail-closed on an unknown day                                                     | COMPLETE | `74801b8` | `packages/engines/src/risk/risk-engine.test.ts` — mutation-checked: `.catch(() => 0)` on the port fails it                                                                |
| 0.8   | Infra-backed end-to-end verification                                                        | COMPLETE | `4f0fdf0` | `apps/api/src/engines/runtime.restart.integration.test.ts` — 4 tests, executed against hosted Mongo + Redis; `pnpm test:integration` exits 0 with 654 tests and 0 skipped |

**This table is checked by CI.** `pnpm check:plan` asserts that every
COMPLETE row names evidence, that every path and commit it cites resolves, that
every BLOCKED row gives a reason, and that each phase STATUS matches the
derivation below. It cannot catch the reverse — code landing without the board
being updated — so §25's `TASK STATUS SET TO:` line remains the human half of
the same job.

**Task IDs are allocated once and never renumbered.** They are cited within
hours of being created — **64 references across source comments today**
(`§0.4` ×9, `§0.5.4` ×10, `§0.5.5` ×17, `§0.5.6` ×26, `§0.8` ×2), plus the
commit messages that closed them. Renumbering orphans every one, which is the
`plan/NN` failure reproduced in code written this month. So the sequence has
gaps and a stray `0.5.x` branch, and that is the cheaper problem: **an ID is an
identifier, not a position.** Rows sort numerically; the `Commit` column carries
the order the work actually happened in.

### Done when

- Market session closes cleanly.
- Final candle is persisted.
- No cross-session candle contamination.
- Restart does not erase today's risk state.
- Broker reconciliation works.
- Existing tests remain green — proved by `pnpm test:integration`, not by
  `pnpm test`. The first fails when a database is unreachable; the second skips
  those suites with a banner so the developer loop does not require Docker.

### Do NOT

Build historical ingestion. Build AI. Add strategies. Refactor architecture.

---

## 6. Phase 1 — Historical 5m data

**STATUS: COMPLETE**

### Goal

Create the canonical historical research dataset.

### Work

Verify the FYERS history API. Implement `HistoryProvider` and pagination.
Normalize broker candles. Validate OHLC and timestamps. Add provenance. Add
trading-calendar handling. Choose initial symbols and history depth. Implement
operator-triggered backfill. Verify that historical and `LIVE_TICK` data coexist
and that no duplicate candles are produced.

### Tasks

Structured around the decisions in
[PHASE_1_HISTORICAL_DATA.md](design/PHASE_1_HISTORICAL_DATA.md), which is the
detailed design for this phase.

| ID   | Task                                                            | STATUS   | Commit               | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | --------------------------------------------------------------- | -------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1  | Candle provenance — `source`, `sourceRank` (D2)                 | COMPLETE | `e5d32cd`            | `packages/core/src/market.ts` — `CandleSourceSchema`, `CANDLE_SOURCE_RANK`; `packages/core/src/core.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                      |
| 1.2  | Source-precedence upsert (D3)                                   | COMPLETE | `e5d32cd`            | `packages/db/src/candles-repository.ts` — rank-conditional upsert; `packages/db/src/repositories.integration.test.ts`                                                                                                                                                                                                                                                                                                                                                                                             |
| 1.3  | Date-range candle query (D4)                                    | COMPLETE | `e5d32cd`            | `packages/db/src/candles-repository.ts` — `findRange`, half-open                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 1.4  | Trading calendar — `tradingDaysBetween` (D5)                    | COMPLETE | `e5d32cd`, `663547b` | `packages/core/src/calendar.ts` — `tradingDaysBetween`; `packages/core/src/calendar.test.ts`. Moved down from `engines` in `663547b` so `broker` can reach it                                                                                                                                                                                                                                                                                                                                                     |
| 1.5  | Decide symbols and history depth (Q6, Q7)                       | COMPLETE | `663547b`            | `docs/design/PHASE_1_HISTORICAL_DATA.md` §10.2 — index-only, one year floored by Q2; binds to `indexSymbols` in `packages/db/src/settings-repository.ts`                                                                                                                                                                                                                                                                                                                                                          |
| 1.6  | `HistoryProvider` port + FYERS adapter, with paging (D1)        | COMPLETE | `663547b`            | `packages/broker/src/history-provider.ts`; `packages/broker/src/fyers-history.ts` — paging, sequential calls, bounded retry; `packages/broker/src/fyers-history.test.ts`                                                                                                                                                                                                                                                                                                                                          |
| 1.7  | Generic bar validation — timestamps, OHLC, ordering, duplicates | COMPLETE | `663547b`            | `packages/core/src/bar-validation.ts` — the seven §5 checks plus finiteness; `packages/core/src/bar-validation.test.ts`                                                                                                                                                                                                                                                                                                                                                                                           |
| 1.8  | Run the FYERS probe; answer Q1–Q5                               | COMPLETE | `33947ba`            | `docs/design/PHASE_1_HISTORICAL_DATA.md` §3.1 — Q1 100 days (150 → HTTP 422), Q2 ≥8 years, Q4 index volume real and non-zero, Q5 HTTP 200 `s: "no_data"`. Q3 stays open and §3.1 shows why it does not bind: the first ingestion is 8 requests total                                                                                                                                                                                                                                                              |
| 1.9  | Vendor-specific validation — holiday / no-data behaviour        | COMPLETE | `8afd5f1`            | `packages/broker/src/fyers-vendor-behaviour.test.ts` — the measured shapes: HTTP 200 `s: "no_data"` for a closed day, an empty-bodied 422 for an over-long range, the real 401. Also `specialSessions` in `packages/core/src/calendar.ts`, after the first run rejected 75 genuine bars of the Budget session                                                                                                                                                                                                     |
| 1.10 | Backfill job + operator CLI (D6)                                | COMPLETE | `173670b`, `8afd5f1` | `apps/api/src/jobs/historical-backfill.ts`; `apps/api/scripts/backfill-candles.mts`. RUN 2026-09-29 into `neelkanth_research`: 36,926 bars, 18,463 per index, 247 trading days, 2025-09-29..2026-09-28, 4 pages per symbol, 0 superseded, 4 rejected (pre-open bars), COMPLETE for both. Verified independently of the run report — 13 checks: no duplicates, every bar stamped and on the 5m grid, the 2026-02-01 Budget session present, declared holidays empty, a known week reads back as 375 ascending bars |
| 1.11 | Historical and `LIVE_TICK` bars coexist; no duplicates          | COMPLETE | `12fe51f`            | `apps/api/src/jobs/historical-backfill.integration.test.ts` — real Mongo, real `CandlesRepository`, both producers interleaved; order-independence and the unique index are the two that carry the claim                                                                                                                                                                                                                                                                                                          |

**The vendor questions are not guessable.** Design §3.1 and §10.1 list five —
maximum range per request, retention depth, rate limits, whether index volume
is real, and what a holiday returns. Each needs one real call. A plausible
guess produces a dataset that is quietly wrong, and every later phase inherits
it, so 1.8 gates 1.9 and the page size in 1.10 rather than being worked around.

**Tasks 1.1–1.4 exist, tested, on `docs/architecture-baseline` (`b07fae4`).**
They are Phase 1 work that was written before the phase opened; the honest
move is to port them now rather than rewrite them.

### Initial scope

Start small: `NIFTY`, `BANKNIFTY`, 5-minute, a bounded historical period. Do not
start with the entire F&O universe.

### Done when

A known historical period can be loaded and queried reliably.

---

## 7. Phase 2 — Trade lifecycle

**STATUS: COMPLETE**

### Goal

Create the canonical completed Trade entity.

```text
Signal → Order → Fill → Position → Active Trade → Exit → Completed Trade
```

### A Trade must contain

`tradeId`, `strategyId`, `strategyVersion`, `symbol`, `side`, `entryOrderId`,
`entryTime`, `entryPrice`, `exitOrderId`, `exitTime`, `exitPrice`, `quantity`,
`exitReason`, `grossPnL`, `charges`, `slippage`, `netPnL`, `entryPattern`,
market context, data provenance.

### Tasks

Structured around the decisions in
[PHASE_2_TRADE_LIFECYCLE.md](design/PHASE_2_TRADE_LIFECYCLE.md), which is the
detailed design for this phase. Q1–Q4 are settled there; Q5 is open and
blocks nothing.

| ID  | Task                                                                                     | STATUS   | Commit                          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------- | -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | Port `5dac705`; audit for drift; apply §5.1's two corrections                            | COMPLETE | `c23d0b0`, `69c61e8`            | `packages/core/src/trade.ts` — §5.1's pro-rata reversal cost and weighted `exitPrice`; drifts 1 and 3 as `DataProvenanceSchema` and `EntryMarketContextSchema`, stamped by `packages/engines/src/strategy/strategy-runner.ts` and carried Signal → Order → `ORDER_FILLED` → Trade. Tests: `packages/core/src/trade.test.ts`, `packages/engines/src/trade/trade-engine.test.ts` (mutation-checked), `packages/engines/src/order/order-manager.test.ts`. Port drift: `packages/db/src/trades-repository.integration.test.ts` now goes through the §0.4 probe. `pnpm test:integration` on `69c61e8` alone: 968 tests, 0 skipped. Outcome recorded in `docs/design/PHASE_2_TRADE_LIFECYCLE.md` §2                                         |
| 2.2 | ~~Answer Q1 and Q2~~ — settled in design §5.1, with Q3 and Q4 in §5.4                    | COMPLETE | `c23d0b0`                       | `docs/design/PHASE_2_TRADE_LIFECYCLE.md` — §5.1 settles Q1 (a reversal is two trades, costs split by quantity) and Q2 (a partial exit is one trade, weighted exit price); §5.4 settles Q3 (an overnight position stays one trade) and Q4 (`strategyVersion` stamped at decision time, never rewritten). Q1 and Q2 are enforced by `packages/core/src/trade.test.ts`                                                                                                                                                                                                                                                                                                                                                                   |
| 2.3 | `trades` collection + indexes; confirm `trade_logs` stays unused                         | COMPLETE | `c23d0b0`, `67444d1`, `e166451` | `packages/db/src/collections.ts` — `trades` registered with a unique `tradeId`, the research and hot-lookup indexes, and no TTL. `packages/db/src/trades-collection.integration.test.ts` asserts all of it against real MongoDB, including that `trade_logs` beside it IS timed. `packages/db/src/trade-logs-unused.test.ts` fails if anything but the registry references `trade_logs` (mutation-checked)                                                                                                                                                                                                                                                                                                                            |
| 2.4 | `TradeEngine` fill idempotency, proven by replaying one event (D5)                       | COMPLETE | `c23d0b0`, `67444d1`, `bdccff5` | `packages/engines/src/trade/trade-engine.ts` — idempotent on `orderId` in memory and across a restart, hydration pre-seeding every leg. `packages/engines/src/trade/trade-idempotency.test.ts` replays entry, closing, add and earlier-exit fills across a simulated restart; none changes the record or opens a phantom. `packages/core/src/trade.ts` records every folded order (`orderIds`); `packages/db/src/trades-repository.ts` matches it, proven against real MongoDB in `packages/db/src/trades-repository.integration.test.ts`. `packages/engines/src/trade/trade-engine.test.ts` pins a failed save healing on the next (mutation-checked). L1–L2 decisions and D5's key in `docs/design/PHASE_2_TRADE_LIFECYCLE.md` §5.7 |
| 2.5 | Entry ↔ exit linkage: `entryOrderId`, `exitOrderId`, `positionId` populated              | COMPLETE | `67444d1`, `9e45eab`            | `packages/core/src/trade.ts` sets `entryOrderId`, `exitOrderId` and `positionId` (set once at open, so a close cannot blank it); `packages/engines/src/trade/trade-engine.ts` resolves the position the same fill just built. `packages/engines/src/trade/trade-idempotency.test.ts` covers the linkage, a vanished position, and a reversal's two halves. L4: the fill now names its signal — `packages/contracts/src/events.ts`, forwarded by `packages/engines/src/order/order-manager.ts` — so `entrySignalId` / `exitSignalId` are populated. `apps/api/src/jobs/trade-round-trip.integration.test.ts` asserts the linkage against real MongoDB                                                                                  |
| 2.6 | `exitReason` threaded from whoever closes the position (D6)                              | COMPLETE | `67444d1`, `da1043e`            | `packages/engines/src/exit/exit-engine.ts` maps its three triggers to `STOP_LOSS`, `TAKE_PROFIT` and `SESSION_CLOSE` (`packages/engines/src/exit/exit-engine.test.ts`). The Order Manager persists and forwards the reason on every fill path (`packages/engines/src/order/order-manager.test.ts`, mutation-checked), and the Trade Engine records it (`packages/engines/src/trade/trade-idempotency.test.ts`) — absent when no closer stated one, never inferred. The four reasons with no producer yet are left absent, not approximated (design D6); producing them is Phase 3                                                                                                                                                     |
| 2.7 | Integration: a full round trip produces exactly one CLOSED trade                         | COMPLETE | `67444d1`, `40fc708`            | Design §7 end to end, against real MongoDB: `apps/api/src/jobs/trade-round-trip.integration.test.ts` runs the real Order Manager, Position Engine and Trade Engine from the signal — one CLOSED trade with both orders, both signals, the position, the version, the reason, the costs and the entry's provenance, unchanged by replaying every fill in-process and after a restart (mutation-checked). `apps/api/src/engines/runtime.restart.integration.test.ts` does it through `startEngineRuntime`, including a closing fill redelivered after a restart. That test found fills projected out of order (design §5.7 L5), fixed in `apps/api/src/engines/runtime.ts` and `packages/engines/src/trade/trade-engine.ts`             |
| 2.8 | `strategyVersion` on `StrategyConfig`, `SignalSchema`, `OrderSchema` (Q4) — all optional | COMPLETE | `67444d1`, `da1043e`, `09e6e89` | `packages/core/src/strategy.ts`, `packages/core/src/signal.ts` and `packages/core/src/order.ts` carry `strategyVersion`, all optional so stored records still parse; the runner stamps it at decision time and the order and fill copy it forward (`packages/engines/src/strategy/strategy-runner.test.ts`, `packages/engines/src/order/order-manager.test.ts`). No route ever set one, so `packages/core/src/strategy-version.ts` derives `cfg-<hash>` from type, params and risk rules when none is declared (PLAN rule 9; `packages/core/src/strategy-version.test.ts`). Decision in `docs/design/PHASE_2_TRADE_LIFECYCLE.md` §5.4                                                                                                 |
| 2.9 | `/trades` read route                                                                     | COMPLETE | `67444d1`                       | `apps/api/src/control-plane/routes.ts` — `GET /trades`: the most recent trades, or a half-open IST date range filtered by strategy and symbol, validated and limited. `apps/api/src/control-plane/routes.test.ts` covers recency, the inclusive final day, both filters, one-sided and inverted ranges, malformed dates, limits and the absence of step-up, against real MongoDB in `pnpm test:integration`                                                                                                                                                                                                                                                                                                                           |

**Phase sign-off:** `pnpm test:integration` on `09e6e89` alone — strict, against
real MongoDB and Redis — 1,003 tests, 0 skipped. Most of the phase landed in
`c23d0b0` and `67444d1` without this board moving; each row was then closed
against its own evidence, and closing them found three defects the landed code
carried — L1, L4 and L5 in the design's §5.7, fixed in 2.4, 2.5 and 2.7.
`check-plan` cannot catch code landing ahead of the board, which is why that
went unnoticed.

**Most of this phase already exists.** `docs/architecture-baseline` carries
`5dac705` — the Trade schema, repository, engine and their tests — deferred
during the Phase 0 port because it belongs here. 2.1 is a port and an audit
rather than new work, which is why it comes first.

**Not in this phase:** a per-strategy square-off opt-out. Q3's rule — an
overnight position stays one trade — holds without it. What it would unlock is
positions that actually survive the night, and that is Phase 3 exit-lifecycle
work (CURRENT_STATE §3.5).

### Done when

Every completed position produces exactly one complete Trade.

---

## 8. Phase 3 — Exit lifecycle

**STATUS: COMPLETE**

### Goal

Every entry must be capable of reaching a deterministic outcome.

### Exit types

`STOP_LOSS`, `TAKE_PROFIT`, `STRATEGY_EXIT`, `TIME_EXIT`, `SESSION_CLOSE`,
`MANUAL_EMERGENCY`, `BROKER_RECONCILIATION`.

### Tasks

Structured around the decisions in
[PHASE_3_EXIT_LIFECYCLE.md](design/PHASE_3_EXIT_LIFECYCLE.md), which is the
detailed design for this phase and keeps each task's dependencies. Q1 and Q3
are settled there (§5.1); Q2 and Q4 are open and block nothing.

| ID  | Task                                                                           | STATUS   | Commit    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------ | -------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | Durable `exiting` guard; add `positionId` to `Order` (D3)                      | COMPLETE | `a5baac2` | `packages/engines/src/exit/exit-engine.ts` consults `packages/db/src/orders-repository.ts` `hasExitInFlight` (PLACED/PENDING by `positionId`, indexed in `packages/db/src/collections.ts`) when memory misses, and releases its guard when the handoff from `apps/api/src/engines/runtime.ts` reports no order (audit A7). Tests: `packages/engines/src/exit/exit-lifecycle.test.ts`, `packages/engines/src/order/order-manager.test.ts` (mutation-checked), and the durable query against real MongoDB in `packages/db/src/repositories.integration.test.ts`                      |
| 3.2 | Answer Q1 and Q3                                                               | COMPLETE | `692a8af` | `docs/design/PHASE_3_EXIT_LIFECYCLE.md` §5.1 — Q1: a strategy exit closes the whole position, an exit while flat is a no-op, scale-out is not this phase. Q3: a bar is judged against the levels it opened with, a trailing stop moves after judging, and stop beats target beats time — with the bar on which trailing first reports `STOP_LOSS` where `TAKE_PROFIT` is the truth, confirmed against the staged engine                                                                                                                                                            |
| 3.3 | Strategy exit verdict → `STRATEGY_EXIT` (D1)                                   | COMPLETE | `b39a2f7` | `packages/engines/src/strategy/strategy-runner.ts` turns an `exit: true` verdict into a close of the whole position held, stamped `STRATEGY_EXIT`; while flat it is recorded as a HOLD, never an entry (audit A2). EMA crossover and RSI reversion now declare their exits (A3). Tests: `packages/engines/src/strategy/strategy-runner.test.ts`, `packages/strategies/src/library.test.ts`                                                                                                                                                                                         |
| 3.4 | Time-in-trade exit → `TIME_EXIT`, measured from the entry fill (D2)            | COMPLETE | `08dddd7` | `ExitRules.maxHoldMinutes` in `packages/core/src/strategy.ts`, judged in `packages/engines/src/exit/exit-engine.ts` from the entry fill to the bar close, with `Position.openedAt` stamped from the fill in `packages/engines/src/position/position-engine.ts` (A6). Settable through `apps/api/src/control-plane/routes.ts` (A4) and part of the derived version in `packages/core/src/strategy-version.ts` (A5). Tests: `packages/engines/src/exit/exit-lifecycle.test.ts`, `packages/engines/src/position/position-engine.test.ts`, `apps/api/src/control-plane/routes.test.ts` |
| 3.5 | Trailing stop, reporting `STOP_LOSS`; mutable protective levels (D4)           | COMPLETE | `8ec709f` | `ExitRules.trailingStopPct`: the stop tightens after a bar is judged, effective from the next bar (design §5.1 Q3, audit A1), reporting `STOP_LOSS`; held in memory and in Mongo via `packages/db/src/positions-repository.ts` `setStopLoss`. Tests: `packages/engines/src/exit/exit-lifecycle.test.ts` — including the §5.1 bar reporting `TAKE_PROFIT`, mutation-checked by restoring trail-first — and `packages/db/src/repositories.integration.test.ts`                                                                                                                       |
| 3.6 | Per-strategy square-off opt-out, defaulting to square off (D6)                 | COMPLETE | `c6b0dbb` | `ExitRules.squareOffAtSessionEnd`, absent meaning true; `packages/engines/src/exit/exit-engine.ts` skips opted-out strategies at the square-off while stops, targets and time exits still apply, and the daily-loss gate is untouched (Q4). Opting out takes step-up in `apps/api/src/control-plane/routes.ts`, proven with the real verifier in `apps/api/src/auth/auth.test.ts`                                                                                                                                                                                                  |
| 3.7 | Manual emergency exit route, behind step-up (D5)                               | COMPLETE | `6022c98` | `POST /positions/:positionId/exit` in `apps/api/src/control-plane/routes.ts`, behind step-up, reporting `MANUAL_EMERGENCY` and closing the whole position; answers 404 when nothing was sent, including when risk refused it. `packages/engines/src/exit/exit-engine.ts` `exitNow`; `apps/api/src/serverless/runtime-projection.ts` answers false. Tests: `packages/engines/src/exit/exit-lifecycle.test.ts`, `apps/api/src/control-plane/routes.test.ts`, `apps/api/src/auth/auth.test.ts`                                                                                        |
| 3.8 | Integration: every simulated entry reaches a completed Trade — the "done when" | COMPLETE | `13d013f` | `packages/engines/src/exit/exit-completeness.test.ts`: real Strategy Runner (EMA crossover), Exit Engine, Order Manager, Position Engine and Trade Engine in memory — six entries end as six closed Trades with six different exit reasons, both orders and a position each, nothing open. Tied to `ExitReasonSchema`; mutation-checked by dropping EMA's `exit: true`                                                                                                                                                                                                             |

**Phase sign-off:** `pnpm test:integration` on `13d013f` — strict, against
real MongoDB and Redis — 1,055 tests, 0 skipped. Most of the phase was written before it
opened and staged uncommitted; it was ported task by task, its exact staged
form kept on branch `wip/phase-3-staged`. Design §8 audited it and §8.1
records what became of every finding: A1 and A2 contradicted the settled Q1
and Q3 and were fixed before their tasks closed.

**Not in this phase:** scale-out — closing part of a position (Q1).

### Done when

Every simulated entry eventually produces `ENTRY → EXIT → COMPLETED TRADE`. No
orphaned simulated entries.

---

## 9. Phase 4 — Deterministic replay

**STATUS: COMPLETE**

### Goal

Run the existing trading pipeline against historical candles.

### Rule

The same dataset, strategy, parameters and seed must produce the same result.

### Replay must include

```text
Market Data → Indicators → Strategy → Signal → Risk
→ Order → Fill → Position → Trade → P&L
```

### Tasks

Structured around the decisions in
[PHASE_4_DETERMINISTIC_REPLAY.md](design/PHASE_4_DETERMINISTIC_REPLAY.md), which
is the detailed design for this phase and keeps each task's dependencies. Q1
and Q2 block the tasks they name; Q3 blocks only the manifest's model names.

| ID  | Task                                                                                                                            | STATUS   | Commit               | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4.1 | Port `ed71384`'s harness extension — ticks, Market Data, Session Manager, Market Bias, Exit Engine — and audit it (design §2.2) | COMPLETE | `b655476`            | `apps/api/src/golden/pipeline.ts` starts from raw ticks and runs the real Market Data Engine (1m and 5m aggregation, the end-of-day flush), Session Manager, Market Bias and Exit engines, with Phase 3's exit ports and placed-or-not handoff wired as the runtime wires them. `apps/api/src/golden/golden-run.test.ts` proves the feed half, both session edges, the three default exits, both sides, a market-view block and a flat close; `apps/api/src/golden/golden-record.json` reproduces byte for byte. Audit outcome in `docs/design/PHASE_4_DETERMINISTIC_REPLAY.md` §2.2 |
| 4.2 | Answer Q1 and Q2                                                                                                                | COMPLETE | `79ef35c`            | `docs/design/PHASE_4_DETERMINISTIC_REPLAY.md` §4.1 — Q1: an index is replayed as a synthetic instrument in index points, marked `synthetic: true` on the manifest; derivative strategies refused. Q2: one untimed `replay_runs` document per run in the research database, its Trades inside the run and never in `trades`                                                                                                                                                                                                                                                           |
| 4.3 | Trade Engine in the harness, fills projected in the runtime's order; the record carries completed Trades                        | COMPLETE | `5270a7a`            | `apps/api/src/golden/pipeline.ts` runs the Trade Engine, fills projected position → trade → strategy as the runtime does; `apps/api/src/golden/golden-record.json` carries three completed Trades (take-profit, stop on a short, square-off) with exit reason, `strategyVersion` and entry-bar source, and is otherwise unchanged. `apps/api/src/golden/golden-run.test.ts` proves linkage, reasons, stamps, and that Trades reconcile with realized P&L                                                                                                                             |
| 4.4 | Candle source: the same pipeline from stored bars, across trading days (D1, D6)                                                 | COMPLETE | `242d52a`            | `apps/api/src/golden/pipeline.ts` `runReplay` takes ticks or stored candles and a list of sessions; a stored bar enters at its close. `apps/api/src/golden/replay-source.test.ts` proves stored bars decide as the feed did, pins the one structural difference (the feed releases a session's final bar only after the close), and replays two days and the Budget Sunday. Days come from the bars (`apps/api/src/replay/sessions.ts`); `packages/engines/src/market-data/session-manager.ts` opens declared special sessions                                                       |
| 4.5 | Run manifest and result fingerprint (D5); answer Q3                                                                             | COMPLETE | `f289f4c`            | `apps/api/src/replay/run.ts` returns a manifest — dataset, strategy and version, seed, special sessions, synthetic symbols, the four model versions with the actual slippage and charge configs — and a sha256 fingerprint of manifest and record (`apps/api/src/replay/run.test.ts`). Q3: versions beside each model, pinned to their outputs by `packages/broker/src/model-versions.test.ts` and `packages/engines/src/risk/sizing-version.test.ts`                                                                                                                                |
| 4.6 | One strategy per run; refuse what cannot be replayed (D4, D8); lookahead guard (D7)                                             | COMPLETE | `23db533`            | `apps/api/src/replay/run.ts` refuses option-chain and derivative strategies, and any whose symbol or interval the dataset lacks (D8), and takes exactly one strategy (D4). `apps/api/src/replay/run.test.ts` proves the refusals, that appending a different later day changes no earlier decision or stop (D7, mutation-checked with a window that reads the future), and that bar order cannot move the fingerprint                                                                                                                                                                |
| 4.7 | Prove read-only: a run writes nothing to the trading collections (D3)                                                           | COMPLETE | `8193bac`            | `apps/api/src/replay/store.ts` reads `candles` and writes `replay_runs`, nothing else. `apps/api/src/replay/store.integration.test.ts` proves it structurally (no replay module names a trading repository) and against real MongoDB: orders, positions, trades, signals and risk_logs holding data are byte-identical after a run (mutation-checked)                                                                                                                                                                                                                                |
| 4.8 | Operator entry point over the research dataset, storing results per Q2                                                          | COMPLETE | `8193bac`, `56a801c` | `apps/api/scripts/replay.mts` over `apps/api/src/replay/store.ts`, keeping runs through `packages/db/src/replay-runs-repository.ts` (untimed, one per run, findable by fingerprint — `packages/db/src/replay-runs-repository.integration.test.ts`); reports signals, risk decisions, Trades by reason and the fingerprint                                                                                                                                                                                                                                                            |
| 4.9 | Acceptance: replay a known historical week twice — identical fingerprints, completed Trades                                     | COMPLETE | `56a801c`            | A real NIFTY week (4 days, 4 Trades) and month (19 days, 20 Trades across four exit reasons) from `neelkanth_research`, each replayed twice as dry runs with identical fingerprints, flat at the end — `docs/design/PHASE_4_DETERMINISTIC_REPLAY.md` §7. The first run exposed a synthetic index that could never fill, fixed in `apps/api/src/replay/run.ts`                                                                                                                                                                                                                        |

**Phase sign-off:** `pnpm test:integration` on `56a801c` — strict, against
real MongoDB and Redis — 1,104 tests, 0 skipped; and a real NIFTY week and
month from `neelkanth_research`, each replayed twice with identical
fingerprints and nothing written (design §7). 4.1 ported the harness extension
that `docs/architecture-baseline` carried inside `ed71384`.

### Done when

Running the same replay twice produces identical results. Replay must never
modify Paper or Live trading state.

---

## 10. Phase 5 — Pattern vocabulary

**STATUS: COMPLETE**

### Goal

Create a small deterministic, versioned pattern library.

Initial patterns may include `ORB_BREAKOUT`, `EMA_CROSS`, `RSI_REVERSION`,
`VWAP_RECLAIM`, `HIGH_VOLUME_BREAKOUT`, `BREAKOUT`, `REJECTION`, `REVERSAL`,
`CONSOLIDATION`, `TREND`, `GAP`, `RANGE`.

Each observation must include `patternId`, `detectorVersion`, timestamp, symbol,
timeframe, market context and data provenance.

### Rules

Patterns are deterministic, reproducible, versioned, and calculated only from
information available at that time. No ML clustering yet.

### Tasks

Structured around the decisions in
[PHASE_5_PATTERN_VOCABULARY.md](design/PHASE_5_PATTERN_VOCABULARY.md), which
is the detailed design for this phase and keeps each task's dependencies.

| ID  | Task                                                                                    | STATUS   | Commit    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5.1 | Port `ed71384`'s pattern library, sweep and observations store; audit it (design §2.2)  | COMPLETE | `2f041c6` | `packages/patterns` (contract, registry, the five detectors), `packages/engines/src/patterns/` (sweep, runner) and `packages/db/src/pattern-observations-repository.ts` ported from `ed71384`; baseline tests pass unmodified. The sweep reads the calendar from `core` (`sessionOpenTsFor` moved there, `packages/core/src/calendar.test.ts`); a Budget Sunday sweeps as its own session (`packages/engines/src/patterns/pattern-sweep.test.ts`); the params key is `canonicalJson`, pinned in `packages/core/src/pattern.test.ts`; the store's Mongo test probes and runs strict, 11/11. Audit outcome in `docs/design/PHASE_5_PATTERN_VOCABULARY.md` §2.3 |
| 5.2 | `HIGH_VOLUME_BREAKOUT` — the spec's name, declining untrustworthy volume (D2, D3)       | COMPLETE | `8dec8ac` | `packages/patterns/src/high-volume-breakout.ts` carries the spec's name; `hasTrustedVolume` in `packages/core/src/market.ts` (only `REAL`); detectors declare `volumeBars` and `packages/patterns/src/registry.ts` declines on any untrusted bar — `HIGH_VOLUME_BREAKOUT` over its lookback and the bar, `VWAP_RECLAIM` over the session (`packages/patterns/src/detectors.test.ts`); the sweep reports `declinedForVolume` (`packages/engines/src/patterns/pattern-sweep.test.ts`). Five mutants killed. Every stored index bar is `SUSPECT`, so on the real year both decline every warm bar — design D3                                                   |
| 5.3 | Observations carry market context and data provenance (D4)                              | COMPLETE | `1af0897` | `packages/core/src/pattern.ts` requires `dataProvenance` and `marketContext` on every occurrence and observation, and refuses provenance naming another bar (`packages/core/src/pattern.test.ts`); `provenanceOf` / `marketContextOf` in `packages/core/src/trade.ts` are the one reading of a bar, used by the registry and by `packages/engines/src/strategy/strategy-runner.ts`; stamped per occurrence across a sweep (`packages/engines/src/patterns/pattern-sweep.test.ts`); Mongo round trip strict, 11/11. Three mutants killed                                                                                                                      |
| 5.4 | Detector versions pinned to their outputs; definitions catalogued in `patterns` (D5)    | COMPLETE | `072abdb` | `packages/engines/src/patterns/detector-versions.test.ts` pins each detector's version to what it finds on a fixed integer series (every detector fires; five mutants killed, one per detector); `PatternDefinition` in `packages/core/src/pattern.ts`, `catalog()` in `packages/patterns/src/registry.ts`, and `packages/db/src/pattern-catalog-repository.ts` keep one definition per version in `patterns`, insert-once, reporting a changed rule as a conflict (`packages/db/src/pattern-catalog-repository.integration.test.ts`, strict 4/4). ORB fires on the break, not the state — design D8                                                         |
| 5.5 | Lookahead guard and determinism (D7)                                                    | COMPLETE | `5abcd3c` | `packages/engines/src/patterns/pattern-sweep-lookahead.test.ts`: on every one of 300 prefixes of a four-session series (every detector firing, the last session different), the prefix sweep equals the full sweep up to its last bar; a window reaching the rest of the session is killed. `packages/engines/src/patterns/pattern-sweep.ts` refuses bars out of order, duplicated, or from another series; repeat sweeps are identical. Design D7                                                                                                                                                                                                           |
| 5.6 | Operator sweep over the research dataset, research database only (D6)                   | COMPLETE | `c53b946` | `apps/api/src/patterns/sweep-store.ts` reads `candles` and writes `patterns` then `pattern_observations`, refusing the whole sweep on a catalogue conflict (a dry run checks read-only); `apps/api/src/patterns/sweep-store.integration.test.ts` (strict 7/7) proves no trading repository is named, trading collections unchanged, provenance stored, a re-run records nothing with the same fingerprint, a dry run keeps nothing. `apps/api/scripts/sweep-patterns.mts` writes only to `neelkanth_research` or a scratch database. Design D6                                                                                                               |
| 5.7 | Acceptance: sweep the real year twice — identical observations carrying every §10 field | COMPLETE | `9314c60` | The stored NIFTY and BANKNIFTY year (36,926 bars, 247 sessions each) swept twice from `neelkanth_research`, read-only: 4,362 observations, identical fingerprints, every one carrying `patternId`, `detectorVersion`, timestamp, symbol, timeframe, market context and data provenance naming its own bar. Recorded twice on a scratch copy: 4,362 new, then 0, same fingerprint. `VWAP_RECLAIM` and `HIGH_VOLUME_BREAKOUT` declined every warm bar on `SUSPECT` index volume. Strict `pnpm test:integration` at `9314c60`: 1,211 tests, 0 skipped. Record in `docs/design/PHASE_5_PATTERN_VOCABULARY.md` §6                                                 |

**Phase sign-off:** `pnpm test:integration` on `9314c60` — strict, against
real MongoDB and Redis — 1,211 tests, 0 skipped; and the stored NIFTY and BANKNIFTY year swept
twice from `neelkanth_research` with identical fingerprints, then recorded
twice on a scratch copy, the second adding nothing (design §6). 5.1 ported the
library, sweep and store that `docs/architecture-baseline` carried inside
`ed71384`.

### Done when

Sweeping the stored year twice yields identical observations, each carrying
`patternId`, `detectorVersion`, timestamp, symbol, timeframe, market context
and data provenance; a second recording adds nothing; and each detector's
version is pinned to what it detects.

---

## 11. Phase 6 — Counterfactual strategy evaluation

**STATUS: COMPLETE**

### Goal

Determine how the same market pattern behaves across different strategies.

```text
VWAP_RECLAIM
      ↓
┌───────────────┐
│ Strategy A    │
│ Strategy B    │
│ Strategy C    │
└───────────────┘
```

Evaluate occurrence count, entries, exits, win/loss, expectancy, drawdown,
costs, slippage and market regime.

### Tasks

Structured around the decisions in
[PHASE_6_COUNTERFACTUAL_EVALUATION.md](design/PHASE_6_COUNTERFACTUAL_EVALUATION.md),
which is the detailed design for this phase and keeps each task's dependencies.

| ID  | Task                                                                                                                                         | STATUS   | Commit    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1 | The replay returns its trail — complete Signals, risk decisions and Trades — record and fingerprint unchanged (D3)                           | COMPLETE | `ff1ab69` | `runReplayWithTrail` in `apps/api/src/golden/pipeline.ts` and `ReplayRun.trail` in `apps/api/src/replay/run.ts` hand out the complete Signals, risk decisions and Trades. `apps/api/src/replay/trail.test.ts` pins the fixed request's fingerprint to its pre-trail value; every Trade complete and linked to its opening Signal; every strategy Signal timed and stamped with its bar; every actionable Signal decided once. Golden record byte-identical; two mutants killed                                                                                                  |
| 6.2 | Eligibility: every registered strategy evaluated or excluded with its reason (D1)                                                            | COMPLETE | `7f3c906` | `apps/api/src/counterfactual/eligibility.ts` lists every registered strategy, eligible or excluded with its reason, by `replayExclusion` — the rule the replay's refusal in `apps/api/src/replay/run.ts` now throws on. `apps/api/src/counterfactual/eligibility.test.ts`: 8 strategies; EMA_CROSSOVER, RSI, ORB evaluated; three DERIVATIVE, two OPTION_CHAIN; agreement with the replay checked by running each type. Two mutants killed                                                                                                                                      |
| 6.3 | The regime label: index trend, versioned, volume-free, pinned, lookahead-proven (D4)                                                         | COMPLETE | `53d0bed` | `apps/api/src/counterfactual/regime.ts`: `REGIME_MODEL_VERSION` 1, the regime index's close against its EMA(21) through the shared fold, volume-free, continuous across sessions; `regimeAt` gives any bar the latest label at or before it. `apps/api/src/counterfactual/regime.test.ts`: every-prefix lookahead proof, volume-independence, pinned outputs; three mutants killed, one equivalent. Design D4                                                                                                                                                                   |
| 6.4 | Attribution and the matrix — relations, metrics, baseline, sample sizes (D5, D6)                                                             | COMPLETE | `7cdabdc` | `apps/api/src/counterfactual/attribution.ts` (ENTERED / SIGNALLED / HOLDING / FLAT, declared window, forward-only, session-bounded, regime at the bar) and `apps/api/src/counterfactual/matrix.ts` (rows per pattern, strategy, symbol, regime with ALL pools and a per-strategy baseline; n, wins, losses, win rate, gross, charges, slippage, net, expectancy, drawdown, hold, exits). `apps/api/src/counterfactual/matrix.test.ts`, 15 tests; five mutants killed. Design D5, D6                                                                                             |
| 6.5 | The counterfactual run: each strategy alone per symbol, manifest and fingerprint (D2, D7)                                                    | COMPLETE | `891e87a` | `apps/api/src/counterfactual/run.ts`: every eligible strategy replayed alone per symbol over the same dataset, the rest listed with their exclusion; sweep, regime, attribution and matrix; a manifest naming dataset, strategy versions and replay fingerprints, detector definitions and params, and every model; a fingerprint. `apps/api/src/counterfactual/run.test.ts`: baseline equals each strategy's own replay, relations sum to occurrences, order-independent fingerprint, declared models change the matrix; four mutants killed. Design D2, D7                    |
| 6.6 | Kept in `strategy_experiments`, research database only; operator CLI (D7)                                                                    | COMPLETE | `6163d32` | `apps/api/src/counterfactual/store.ts` reads `candles` and writes one `strategy_experiments` document; `packages/db/src/strategy-experiments-repository.ts` keeps it insert-once, untimed (strict 4/4). `apps/api/src/counterfactual/store.integration.test.ts` (strict): no trading repository named, trading collections unchanged, kept run equals the pure one, dry run keeps nothing; two mutants killed. `apps/api/scripts/counterfactual.mts` writes only to the research or a scratch database. Finding F2 in the design §5                                             |
| 6.7 | Fix F2: a strategy that declares no indicators runs on its own — the Indicator Engine publishes for every series a strategy is registered on | COMPLETE | `c657874` | `IndicatorEngine.track` in `packages/engines/src/indicators/indicator-engine.ts` and `provisionSeries` in `packages/engines/src/indicators/register-spec.ts`, used by `apps/api/src/engines/runtime.ts` and `apps/api/src/golden/pipeline.ts`: a series a strategy is registered on publishes on every closed bar. `packages/engines/src/indicators/indicator-engine.test.ts` and `apps/api/src/replay/run.test.ts` (ORB alone decides); three mutants killed; golden record and replay fingerprint unchanged. `docs/architecture/CURRENT_STATE.md` §5.9                        |
| 6.8 | Acceptance: the real year twice — identical fingerprints, and the question answered                                                          | COMPLETE | `954ace2` | The stored NIFTY and BANKNIFTY year (36,926 bars, 247 sessions) evaluated twice from `neelkanth_research`, read-only: identical fingerprints; EMA_CROSSOVER, RSI, ORB evaluated on each symbol, five strategies excluded with reasons; 129 matrix rows, `n` on every one, answering per pattern how each strategy entered, signalled, held or stood aside and what it earned. Kept twice on a scratch copy under the research fingerprint. Strict `pnpm test:integration` at `954ace2`: 1,261 tests, 0 skipped. Record in `docs/design/PHASE_6_COUNTERFACTUAL_EVALUATION.md` §7 |

**Phase sign-off:** `pnpm test:integration` on `954ace2` — strict, against
real MongoDB and Redis — 1,261 tests, 0 skipped; and the stored NIFTY and BANKNIFTY year
evaluated twice from `neelkanth_research` with identical fingerprints, every
strategy evaluated or excluded with its reason, then kept on a scratch copy
(design §7). Built here, on Phase 4's replay and Phase 5's sweep; 6.7 fixed
F2, a trading-core defect the phase found, on the operator's decision.

### Done when

Research can answer: "When this pattern occurred, how did each strategy behave?"

---

## 12. Phase 7 — Statistical validation

**STATUS: COMPLETE**

### Goal

Prevent small samples and overfitting from becoming fake conclusions.

### Requirements

Hypothesis registry, minimum sample size, confidence/statistical rules,
out-of-sample separation, multiple-comparison awareness, cost model, slippage
model, parameter versioning.

Never conclude `78% win rate` without also knowing sample size, period, market
regime, costs, slippage and out-of-sample status.

### Tasks

Structured around the decisions in
[PHASE_7_STATISTICAL_VALIDATION.md](design/PHASE_7_STATISTICAL_VALIDATION.md),
which is the detailed design for this phase and keeps each task's dependencies.

| ID  | Task                                                                                          | STATUS   | Commit    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------- | -------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1 | Statistics primitives, pinned to reference values (D1)                                        | COMPLETE | `1952399` | `apps/api/src/validation/stats.ts`: normal CDF and quantile, Wilson interval, exact binomial tail, sample spread, mean interval and one-sided z-test, Holm correction. `apps/api/src/validation/stats.test.ts` pins each against SciPy, R, statsmodels or exact values (binomial to 1e-12); four mutants killed. Design D1                                                                                                                                                                                                                                                   |
| 7.2 | A matrix cell carries its dispersion; counterfactual version 2 (D2)                           | COMPLETE | `fdfda8c` | `TradeStats` in `apps/api/src/counterfactual/matrix.ts` carries `netStdDev` and `perUnitStdDev` (sample, null below two Trades), tested in `apps/api/src/counterfactual/matrix.test.ts`; `COUNTERFACTUAL_VERSION` 2 in `apps/api/src/counterfactual/run.ts`. Design D2                                                                                                                                                                                                                                                                                                       |
| 7.3 | The hypothesis: schema, rules, fingerprint, registry (D3)                                     | COMPLETE | `ece6892` | `apps/api/src/validation/hypothesis.ts`: `HypothesisSchema` (cell, metric, direction, threshold, alpha, minimum sample with a floor of 30, in- and out-of-sample windows, run, pinned versions), `hypothesisFingerprint`, `nextHypothesisId`, `pinsFor`. `apps/api/src/validation/hypothesis.test.ts`: every refusal, fingerprint independence from registration time and key order, pins read off a real run; three mutants killed. Design D3                                                                                                                               |
| 7.4 | The gate: one out-of-sample test — minimum sample, interval, p-value, version check (D4, D5)  | COMPLETE | `4f1e278` | `apps/api/src/validation/gate.ts`: `testHypothesis` refuses a test before registration, a run outside its window, or a run under unpinned versions; returns INSUFFICIENT_SAMPLE below the minimum; judges a win rate by the exact binomial tail and Wilson interval, an expectancy by a one-sided z-test on the cell's spread; verdict out of sample only. `apps/api/src/validation/gate.test.ts`, checked against hand arithmetic; six mutants killed. Design D4, D5                                                                                                        |
| 7.5 | Families: Holm correction; a finding that cannot be said without its context (D6, D7)         | COMPLETE | `6503d16` | `apps/api/src/validation/family.ts`: `familyFindings` (Holm across every registered member, untested and too-small at p = 1; one alpha; edited or twice-tested claims refused) and `FindingSchema` / `describeFinding` (a finding without its n, period, regime, costs, slippage, versions or out-of-sample status cannot be said). `apps/api/src/validation/family.test.ts` against R's p.adjust; four mutants killed. Design D6, D7                                                                                                                                        |
| 7.6 | Kept in `strategy_experiments`, research database only; operator CLI (D8)                     | COMPLETE | `e1d920d` | `apps/api/src/validation/store.ts`: `registerHypothesis` (once, and never the same claim twice), `testRegistered` (in- and out-of-sample runs under the pinned settings, insert-once — a second test refused), `familyReport`; kept in `strategy_experiments` as HYPOTHESIS and HYPOTHESIS_TEST. `apps/api/src/validation/store.integration.test.ts` strict 4/4, trading untouched; the hypothesis fingerprint is the claim's substance. `apps/api/scripts/hypotheses.mts` register / test / report, research or scratch database only. Design D8                            |
| 7.7 | Acceptance: a family registered on the first half of the real year, tested once on the second | COMPLETE | `c93a97b` | Family `F-2026H2` — eight claims formed on the first half of the stored year (2025-09-29 .. 2026-03-27), registered before any test through `apps/api/scripts/hypotheses.mts`, tested once each on the second (2026-03-30 .. 2026-09-28) on a scratch copy: four SUPPORTED, one NOT_SUPPORTED, three INSUFFICIENT_SAMPLE; Holm across all eight; a re-registered claim and a second test refused; every finding rendered with its context. Strict `pnpm test:integration` at `c93a97b`: 1,303 tests, 0 skipped. Record in `docs/design/PHASE_7_STATISTICAL_VALIDATION.md` §6 |

**Phase sign-off:** `pnpm test:integration` on `c93a97b` — strict, against
real MongoDB and Redis — 1,303 tests, 0 skipped; and a family of eight claims formed on the
first half of the stored year, registered before any test, tested once each
on the second half through the CLI — four supported, one not, three refused
for sample size, a re-registration and a second test refused (design §6).
Built here, on Phase 6's counterfactual run.

### Done when

A family of hypotheses formed on the first half of the stored year, registered
before any test, is tested once each on the second half: every verdict carries
sample size, interval, p-value, costs, slippage, regime, versions and
out-of-sample status; small samples are refused; the family correction is
applied and shown; and a second test of a hypothesis is refused.

---

## 13. Phase 8 — Daily research

**STATUS: COMPLETE**

### Goal

Automatically analyse each completed trading day.

```text
Load candles → Compute features → Detect patterns → Find strategy signals
→ Find trades → Link entry to exit → Analyse outcome → Store evidence
```

Output: Daily Research Report, Pattern Observations, Strategy Observations,
Trade Evidence, Chart Specifications. **No PNG is the source of truth.**

### Tasks

Structured around the decisions in
[PHASE_8_DAILY_RESEARCH.md](design/PHASE_8_DAILY_RESEARCH.md), which is the
detailed design for this phase and keeps each task's dependencies.

| ID  | Task                                                                                                           | STATUS   | Commit    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1 | The day's run: K sessions ending at D, reporting D alone; independent of later bars and of the batch (D1)      | COMPLETE | `b28f941` | `apps/api/src/research/day.ts`: `runDay` over the K = 5 sessions ending at D, reporting D alone; `evaluateMarket` split out of `apps/api/src/counterfactual/run.ts`. `apps/api/src/research/day.test.ts`: independent of bars after D and of where the loaded range begins, dependent on the declared lookback; three mutants killed. Design D1                                                                                                                                                                                                         |
| 8.2 | Trade evidence: entry to exit, excursions, what preceded the entry (D2)                                        | COMPLETE | `823826d` | `apps/api/src/research/evidence.ts`: `tradeEvidence` — entry Signal and bar, exit, outcome and costs, held bars, maximum favourable and adverse excursion, regime and patterns preceding the entry; `excursionOf`. `apps/api/src/research/evidence.test.ts`: on a real day and on a constructed one with occurrences on every boundary; three mutants killed. Design D2                                                                                                                                                                                 |
| 8.3 | Observations: day features, patterns compared across strategies, each strategy's day (D3)                      | COMPLETE | `a96de7d` | `apps/api/src/research/observations.ts`: `dayFeatures`, `patternObservations` (each occurrence put to every strategy, linked to Trade evidence), `strategyObservations` (every registered strategy, proposals, approvals, blocks by check, Trades). `apps/api/src/research/observations.test.ts`, 7 tests; two mutants killed. Design D3                                                                                                                                                                                                                |
| 8.4 | Chart specifications for the day and each Trade; volume overlays only on real volume (D4)                      | COMPLETE | `c761c83` | `apps/api/src/research/charts.ts`: `dayChart` and `tradeChart` — specifications, never images; strategy indicators as overlays; volume-derived overlays only on REAL volume, omissions annotated; every marker inside its span. `apps/api/src/research/charts.test.ts`, 6 tests; three mutants killed. Design D4                                                                                                                                                                                                                                        |
| 8.5 | The report: inputs fingerprinted, versioned, kept in `research_reports`; staleness (D5)                        | COMPLETE | `2e6c01e` | `apps/api/src/research/report.ts`: `buildDailyReports` (every section, inputs fingerprinted, content fingerprint), `isStale` (exactly the reports whose bars changed); `apps/api/src/research/report.test.ts`, two mutants killed. `packages/db/src/research-reports-repository.ts`: `research_reports`, one per (period, date, symbol, version), insert-once, revisions beside originals, `latestReading` for revisions (`packages/db/src/research-reports-repository.integration.test.ts`, strict 4/4). Design D5                                     |
| 8.6 | Every completed, unreported day, automatically and idempotently; CLI (D6)                                      | COMPLETE | `f9703ee` | `apps/api/src/research/store.ts`: `runDailyResearch` — every completed, unreported day; stale reports recomputed as new versions on request; idempotent. `apps/api/src/research/store.integration.test.ts` (strict 6/6): ten days once, nothing added on re-run, today left until its close, one revised bar recomputing exactly the five reports that read it as v2; two mutants killed. `apps/api/scripts/daily-research.mts` for a scheduler, research or scratch database only. Design D6                                                           |
| 8.7 | Acceptance: the real year reported; a re-run adds nothing; a revised bar is caught and recomputed as version 2 | COMPLETE | `11f9b1a` | The stored year researched through `apps/api/scripts/daily-research.mts` on a scratch copy: 494 reports (247 days × 2 instruments) in 57 s; a second run adding nothing; one revised NIFTY bar recomputing exactly the ten reports that read it — its day and the next four sessions, both instruments — as version 2 beside version 1; a stored report reproduced from `neelkanth_research` alone with the same fingerprint. Strict `pnpm test:integration` at `11f9b1a`: 1,345 tests, 0 skipped. Record in `docs/design/PHASE_8_DAILY_RESEARCH.md` §6 |

**Phase sign-off:** `pnpm test:integration` on `11f9b1a` — strict, against
real MongoDB and Redis — 1,345 tests, 0 skipped; and the stored year researched through the
CLI on a scratch copy: 494 reports, a second run adding nothing, one revised
bar recomputing exactly the ten reports that read it as version 2, and a
stored report reproduced from the research database alone (design §6). Built
here, on Phase 6's counterfactual run, one trading day at a time.

### Done when

Every trading day of the stored year has a report per instrument, produced by
one command that adds nothing when run again; each report is reproducible from
its day alone; and a revised bar marks exactly the reports that read it stale,
recomputed as new versions beside the old.

---

## 14. Phase 9 — Weekly / monthly / quarterly research

**STATUS: COMPLETE**

Aggregate daily evidence. Weekly: find recurring behaviour. Monthly: find
persistent weaknesses and opportunities. Quarterly: check whether findings
survive different market regimes. All windows use the trading calendar.

### Tasks

Structured around the decisions in
[PHASE_9_PERIODIC_RESEARCH.md](design/PHASE_9_PERIODIC_RESEARCH.md), which is
the detailed design for this phase and keeps each task's dependencies.

| ID  | Task                                                                                                                                          | STATUS   | Commit    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9.1 | Trading-calendar windows from a declared calendar; coverage — gaps and unexpected days (D1, D2)                                               | COMPLETE | `0c4ec1f` | `apps/api/src/research/windows.ts`: ISO weeks, months and quarters; trading days from a declared calendar; `coverageOf` naming gaps and unexpected days; completeness; calendar fingerprint. `apps/api/src/research/windows.test.ts`, 11 tests (a Holi week of four days, the Budget Sunday in its week, 53 weeks in 2026); three mutants killed. Design D1, D2                                                                                                                                                                                                                                        |
| 9.2 | One aggregation over daily reports: pattern × strategy × regime, strategy, condition; day-level consistency (D3)                              | COMPLETE | `41db399` | `apps/api/src/research/aggregate.ts`: pairs per pattern × strategy × regime, strategies, conditions (strategy, entry regime, preceding patterns); every Tally with n, net, expectancy, costs and day-level consistency; Trades keyed by date. `apps/api/src/research/aggregate.test.ts`, 9 tests; three mutants killed. Design D3                                                                                                                                                                                                                                                                      |
| 9.3 | The questions: weekly recurrence, monthly weaknesses and opportunities, quarterly survival (D4)                                               | COMPLETE | `f66f21d` | `apps/api/src/research/questions.ts`: `weeklyAnswers` (recurrence against the week's trading days, what worked, repeated failure), `monthlyAnswers` (weaknesses and opportunities among conditions with enough Trades, extremes, regime sign change), `quarterlyAnswers` (SURVIVES / REGIME_DEPENDENT / UNSTABLE / INSUFFICIENT, with the rule that decided it); thresholds on every answer. `apps/api/src/research/questions.test.ts`, 12 tests; four mutants killed. Design D4                                                                                                                       |
| 9.4 | The window report: daily reports it read, versioned, kept in `research_reports`; staleness (D5)                                               | COMPLETE | `b59c6f4` | `apps/api/src/research/window-report.ts`: `buildWindowReport` (calendar, per-instrument coverage, aggregate, answers, the daily reports it read) and `isWindowStale` (a superseded daily or a filled gap; nothing outside its span). `apps/api/src/research/window-report.test.ts`, 9 tests, two mutants killed. `packages/db/src/research-reports-repository.ts` holds WEEK, MONTH and QUARTER beside DAY (strict 5/5). Design D5                                                                                                                                                                     |
| 9.5 | Every complete, unreported window, automatically and idempotently; CLI (D6)                                                                   | COMPLETE | `c6a1124` | `apps/api/src/research/periodic-store.ts`: `runPeriodicResearch` — every complete, unreported window; stale ones recomputed as new versions on request; idempotent. `apps/api/src/research/periodic-store.integration.test.ts` (strict 4/4): incomplete windows left, a re-run adding nothing, gaps named, one revised bar recomputing exactly its two weeks, nothing but `research_reports` changed. `apps/api/scripts/periodic-research.mts` requires a declared calendar. Design D6                                                                                                                 |
| 9.6 | Acceptance: the real year's weeks, months and quarters under the exchange's published calendar; a daily revision reaching exactly its windows | COMPLETE | `0205981` | The stored year's 71 windows (53 weeks, 13 months, 5 quarters) researched through `apps/api/scripts/periodic-research.mts` on a scratch copy under `apps/api/scripts/calendars/nse-2025-26.json`: coverage clean inside the data, gaps only at its edges; without a calendar the same weeks would show 19 gap days; a second run adding nothing; one revised bar recomputing exactly 2026-W10, W11, 2026-03 and 2026-Q1 as version 2; the settings calendar refused (F1). Strict `pnpm test:integration` at `0205981`: 1,392 tests, 0 skipped. Record in `docs/design/PHASE_9_PERIODIC_RESEARCH.md` §7 |

**Phase sign-off:** `pnpm test:integration` on `0205981` — strict, against
real MongoDB and Redis — 1,392 tests, 0 skipped; and the stored year's 71 weeks, months and
quarters researched through the CLI on a scratch copy under the exchange's
published calendar — coverage clean inside the data, a second run adding
nothing, one revised bar recomputing exactly its two weeks, month and quarter
(design §7). **No trading calendar is configured in settings** (finding F1):
windows are built from a declared calendar, never inferred from missing bars.

### Done when

Every complete week, month and quarter of the stored year has a report built
from the exchange's trading calendar — coverage stated, gaps named, each answer
carrying its `n` — produced by one command that adds nothing when run again;
and a revised daily report recomputes exactly the windows that read it.

---

## 15. Phase 10 — Research knowledge base

**STATUS: READY**

### Goal

Make accumulated research searchable.

Store research reports, patterns, pattern observations, strategy experiments,
backtests, walk-forward results, trade evidence, documents, chart specifications
and AI analysis. The knowledge base becomes the foundation for the AI agent.

---

## 16. Phase 11 — AI research agent

**STATUS: READY**

### Goal

Build an AI that can reason over structured research evidence.

### Initial tools

`findPatterns()`, `strategyMatrix()`, `similarSessions()`, `tradeHistory()`,
`newsContext()`, `runBacktest()`, `runWalkForward()`.

### The agent can

Investigate questions, summarize evidence, compare strategies, find recurring
patterns, identify anomalies, propose hypotheses, request backtests and explain
research findings.

### The agent cannot

Place broker orders, bypass the Risk Engine, change Live limits, disable safety
systems, or promote itself to Live.

Every answer must include sample size, date range, strategy version, data
version and cost assumptions.

---

## 17. Phase 12 — Automated strategy hypothesis

**STATUS: READY**

Only after Phase 11. AI may propose `Hypothesis → Registry → Validation`. A
proposal is not automatically a strategy.

---

## 18. Phase 13 — Backtest + walk-forward

**STATUS: READY**

Every serious candidate must pass `Historical Backtest → Out-of-Sample →
Walk-Forward → Cost/Slippage Validation`. No direct promotion from AI suggestion
to Live.

---

## 19. Phase 14 — Paper validation

**STATUS: READY**

Candidate runs against real-time market data without real money. Validate
signals, execution, fills, slippage, risk, positions, exits, P&L, restart
recovery and broker reconciliation.

---

## 20. Phase 15 — Promotion

**STATUS: READY**

```text
Research → Candidate → Historical validation → Walk-forward → Paper
→ Promotion candidate → Human approval → Live
```

Live requires every safety gate.

---

## 21. Strategy development rule

Adding strategies is NOT its own uncontrolled roadmap. For every new strategy:

```text
Strategy Definition → Required Data → Implementation → Unit Tests
→ Historical Replay → Cost Model → Statistical Validation
→ Walk-Forward → Paper
```

For option strategies additionally verify lot size, expiry, strike selection,
OI, volume quality, IV, bid/ask spread, slippage, charges and liquidity.

---

## 22. News track

News is parallel data infrastructure.

```text
Market Track                    News Track
    ├── Historical Data             ├── Ingestion
    ├── Trade                       ├── Classification
    ├── Replay                      └── Market linkage
    └── Research
         └──────────────┬──────────────┘
                        ↓
                     Research
```

News must not block the core market-data → trade → replay path.

---

## 23. What Claude must do before every task

1. Read this PLAN.md.
2. Identify the current phase.
3. Identify the exact task.
4. Read only the relevant architecture/spec sections.
5. Inspect the actual working branch.
6. Find existing implementation.
7. Reuse existing contracts.
8. Identify dependencies.
9. Implement only the current task.
10. Run relevant tests.
11. Report what changed.
12. Report what remains blocked.

---

## 24. What Claude must NEVER do

Jump to a later phase. Build AI early. Invent missing data. Fabricate broker
behaviour. Create duplicate architecture. Create a second strategy framework.
Create duplicate repositories. Rename the project. Rename packages without
explicit approval. Rewrite working code unnecessarily. Add microservices just
for appearance. Bypass the Risk Engine. Connect AI directly to the broker. Mark
a task complete without acceptance evidence.

---

## 25. Current task

Claude must always end its planning analysis with:

```text
CURRENT PHASE:
CURRENT TASK:
WHY THIS TASK:
DEPENDENCIES:
FILES TO INSPECT:
FILES TO CHANGE:
ACCEPTANCE TEST:
TASK STATUS SET TO:
NEXT TASK:
```

Only one task should be actively implemented at a time. `TASK STATUS SET TO:`
exists so that closing a task and updating its row in §4/§5 are the same action
rather than two — which is how a board and its code drift apart.

---

## 26. Definition of done

A phase is complete only when:

1. Implementation exists.
2. Tests exist.
3. Relevant tests pass.
4. Existing behaviour is not unintentionally broken.
5. Acceptance criteria pass.
6. Documentation reflects the actual state.
7. No known blocker is hidden.
8. The git diff contains only related changes.

---

## 27. Current priority

Phases 0 to 9 are complete. The immediate priority is **Phase 10 — Research
knowledge base**.

Do not begin Phase 11 until Phase 10's acceptance criteria pass. Do not begin
research phases until replay and Trade outcomes are trustworthy. Do not build
the AI research agent before the research knowledge base exists.

---

## 28. Source of truth

Priority order:

1. This PLAN.md
2. [ARCHITECTURE_DECISION.md](architecture/ARCHITECTURE_DECISION.md)
3. [RND_RESEARCH_SPECIFICATION.md](architecture/RND_RESEARCH_SPECIFICATION.md)
4. Existing source code
5. Tests
6. Older planning documents

If two documents conflict:

- **PLAN.md wins for implementation order.**
- **ARCHITECTURE_DECISION.md wins for architectural decisions.**
- **RND_RESEARCH_SPECIFICATION.md wins for detailed research behaviour.**

**Never silently choose between conflicting documents. Report the conflict.**

---

## 29. Document roles

The architecture and research documents are not execution plans and must not be
read as one. They hold detailed reference material for every feature; what they
do not hold is the answer to "what do I build now".

```text
                    PLAN.md
                       │
              "WHAT DO I BUILD NOW?"
                       │
          ┌────────────┼────────────┐
          ↓            ↓            ↓
   CURRENT_STATE      ADR        RND SPEC
   "What exists?"    "Why?"    "How should R&D behave?"
```

| Document                                                                                   | Answers                          | Never contains |
| ------------------------------------------------------------------------------------------ | -------------------------------- | -------------- |
| `docs/PLAN.md`                                                                             | What to build now, in what order | —              |
| [`architecture/CURRENT_STATE.md`](architecture/CURRENT_STATE.md)                           | What exists today                | Phase ordering |
| [`architecture/ARCHITECTURE_DECISION.md`](architecture/ARCHITECTURE_DECISION.md)           | Why it is shaped this way        | Phase ordering |
| [`architecture/RND_RESEARCH_SPECIFICATION.md`](architecture/RND_RESEARCH_SPECIFICATION.md) | How R&D must behave              | Phase ordering |

**Status lives in exactly one file — this one.** Drift between N documents is
arithmetically impossible only at N = 1. It previously stood at three, which is
how a single commit could implement `0.5.4`–`0.5.6` and, in that same commit,
leave a board saying they had not been started.
