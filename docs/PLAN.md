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
| 1     | Historical 5m data                 | READY    |
| 2     | Trade lifecycle                    | READY    |
| 3     | Exit lifecycle                     | READY    |
| 4     | Deterministic replay               | READY    |
| 5     | Pattern vocabulary                 | READY    |
| 6     | Counterfactual strategy evaluation | READY    |
| 7     | Statistical validation             | READY    |
| 8     | Daily research                     | READY    |
| 9     | Periodic research                  | READY    |
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

**STATUS: READY**

### Goal

Create the canonical historical research dataset.

### Work

Verify the FYERS history API. Implement `HistoryProvider` and pagination.
Normalize broker candles. Validate OHLC and timestamps. Add provenance. Add
trading-calendar handling. Choose initial symbols and history depth. Implement
operator-triggered backfill. Verify that historical and `LIVE_TICK` data coexist
and that no duplicate candles are produced.

### Initial scope

Start small: `NIFTY`, `BANKNIFTY`, 5-minute, a bounded historical period. Do not
start with the entire F&O universe.

### Done when

A known historical period can be loaded and queried reliably.

---

## 7. Phase 2 — Trade lifecycle

**STATUS: READY**

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

### Done when

Every completed position produces exactly one complete Trade.

---

## 8. Phase 3 — Exit lifecycle

**STATUS: READY**

### Goal

Every entry must be capable of reaching a deterministic outcome.

### Exit types

`STOP_LOSS`, `TAKE_PROFIT`, `STRATEGY_EXIT`, `TIME_EXIT`, `SESSION_CLOSE`,
`MANUAL_EMERGENCY`, `BROKER_RECONCILIATION`.

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

The immediate priority is **Phase 0 — Repository + runtime integrity**, then
**Phase 1 — Historical 5m data**.

Do not begin Phase 2 until Phase 1's acceptance criteria pass. Do not begin
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
