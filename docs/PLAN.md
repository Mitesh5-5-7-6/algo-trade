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

| Phase | Deliverable                        | STATUS      |
| ----- | ---------------------------------- | ----------- |
| 0     | Repository + runtime integrity     | COMPLETE    |
| 1     | Historical 5m data                 | COMPLETE    |
| 2     | Trade lifecycle                    | COMPLETE    |
| 3     | Exit lifecycle                     | IN PROGRESS |
| 4     | Deterministic replay               | READY       |
| 5     | Pattern vocabulary                 | READY       |
| 6     | Counterfactual strategy evaluation | READY       |
| 7     | Statistical validation             | READY       |
| 8     | Daily research                     | READY       |
| 9     | Periodic research                  | READY       |
| 10    | Research knowledge base            | READY       |
| 11    | AI research agent                  | READY       |
| 12    | Automated strategy hypotheses      | READY       |
| 13    | Backtest + walk-forward            | READY       |
| 14    | Paper validation                   | READY       |
| 15    | Promotion                          | READY       |

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

**STATUS: IN PROGRESS**

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

| ID  | Task                                                                           | STATUS   | Commit    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------ | -------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | Durable `exiting` guard; add `positionId` to `Order` (D3)                      | READY    | —         | —                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3.2 | Answer Q1 and Q3                                                               | COMPLETE | `692a8af` | `docs/design/PHASE_3_EXIT_LIFECYCLE.md` §5.1 — Q1: a strategy exit closes the whole position, an exit while flat is a no-op, scale-out is not this phase. Q3: a bar is judged against the levels it opened with, a trailing stop moves after judging, and stop beats target beats time — with the bar on which trailing first reports `STOP_LOSS` where `TAKE_PROFIT` is the truth, confirmed against the staged engine |
| 3.3 | Strategy exit verdict → `STRATEGY_EXIT` (D1)                                   | READY    | —         | —                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3.4 | Time-in-trade exit → `TIME_EXIT`, measured from the entry fill (D2)            | READY    | —         | —                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3.5 | Trailing stop, reporting `STOP_LOSS`; mutable protective levels (D4)           | READY    | —         | —                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3.6 | Per-strategy square-off opt-out, defaulting to square off (D6)                 | READY    | —         | —                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3.7 | Manual emergency exit route, behind step-up (D5)                               | READY    | —         | —                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3.8 | Integration: every simulated entry reaches a completed Trade — the "done when" | READY    | —         | —                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Most of this phase is written but not committed.** It is staged on
`new-ai-agent-v1`, and design §8 audits it against Q1, Q3 and D1–D6. Two
findings contradict the settled answers and must change before their tasks
close: A1, the trailing stop judges a bar against a level that bar set (3.5),
and A2, an exit verdict while flat can open a position (3.3). Each row closes
with the commit that lands its part, against its own evidence.

**Not in this phase:** scale-out — closing part of a position (Q1).

### Done when

Every simulated entry eventually produces `ENTRY → EXIT → COMPLETED TRADE`. No
orphaned simulated entries.

---

## 9. Phase 4 — Deterministic replay

**STATUS: READY**

### Goal

Run the existing trading pipeline against historical candles.

### Rule

The same dataset, strategy, parameters and seed must produce the same result.

### Replay must include

```text
Market Data → Indicators → Strategy → Signal → Risk
→ Order → Fill → Position → Trade → P&L
```

### Done when

Running the same replay twice produces identical results. Replay must never
modify Paper or Live trading state.

---

## 10. Phase 5 — Pattern vocabulary

**STATUS: READY**

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

---

## 11. Phase 6 — Counterfactual strategy evaluation

**STATUS: READY**

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

### Done when

Research can answer: "When this pattern occurred, how did each strategy behave?"

---

## 12. Phase 7 — Statistical validation

**STATUS: READY**

### Goal

Prevent small samples and overfitting from becoming fake conclusions.

### Requirements

Hypothesis registry, minimum sample size, confidence/statistical rules,
out-of-sample separation, multiple-comparison awareness, cost model, slippage
model, parameter versioning.

Never conclude `78% win rate` without also knowing sample size, period, market
regime, costs, slippage and out-of-sample status.

---

## 13. Phase 8 — Daily research

**STATUS: READY**

### Goal

Automatically analyse each completed trading day.

```text
Load candles → Compute features → Detect patterns → Find strategy signals
→ Find trades → Link entry to exit → Analyse outcome → Store evidence
```

Output: Daily Research Report, Pattern Observations, Strategy Observations,
Trade Evidence, Chart Specifications. **No PNG is the source of truth.**

---

## 14. Phase 9 — Weekly / monthly / quarterly research

**STATUS: READY**

Aggregate daily evidence. Weekly: find recurring behaviour. Monthly: find
persistent weaknesses and opportunities. Quarterly: check whether findings
survive different market regimes. All windows use the trading calendar.

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

Phases 0, 1 and 2 are complete. The immediate priority is **Phase 3 — Exit
lifecycle**.

Do not begin Phase 4 until Phase 3's acceptance criteria pass. Do not begin
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
