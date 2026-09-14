# R&D Research Specification — Neelkanth Trader

**Status:** Specification baseline
**Governed by:** [ARCHITECTURE_DECISION.md](ARCHITECTURE_DECISION.md)
**Current reality:** [CURRENT_STATE.md](CURRENT_STATE.md)
**Supersedes:** `Algo_Trade_AI_Agent_RnD_Plan_Tomorrow.md` (deleted)

This document specifies the Market R&D system: a continuously growing research laboratory that studies historical and daily market behaviour — 5-minute candles, market structure, strategy behaviour and actual trade outcomes — in order to learn _which strategies work with which patterns, under which conditions, and why_.

Section status tags carry the same meaning as in the architecture decision: `DECIDED`, `PROPOSED`, `DEFERRED`, `CURRENT GAP`.

**Nothing in this document describes software that exists today** unless a section explicitly says so. Phase headings state implementation targets, not accomplishments.

---

## 1. The spine — `DECIDED`

This is the single most important decision in the document, and the one most easily got wrong.

R&D does **not** begin at AI, or at patterns, or at strategies. It begins at data and ends at AI:

```
Historical Data
      ↓
Validated 5m Candles
      ↓
Deterministic Replay
      ↓
Strategy
      ↓
Entry
      ↓
Exit
      ↓
Completed Trade
      ↓
Outcome
      ↓
Pattern ↔ Strategy ↔ Outcome
      ↓
Statistics
      ↓
Research
      ↓
AI
```

Any other ordering asks a language model to discover wisdom from a database that does not yet contain the evidence. The dataset comes first; the intelligence layer sits on top of it.

This ordering is the organising principle of the whole specification, not a section within it. Every phase in §4 is a segment of this chain, in order.

---

## 2. Purpose and non-goals — `DECIDED`

### 2.1 What the system must discover

- Why a particular market pattern worked.
- Which strategies worked with that pattern.
- Which strategies failed with the same pattern.
- Under which market conditions each strategy works or fails.
- Whether the same pattern has appeared historically.
- Which strategy improvements are worth testing.

### 2.2 What it is not

- Not a daily P&L report.
- Not an LLM connected to a broker.
- Not a system that promotes a strategy because yesterday went well.
- Not a machine-learning pipeline. Storing data is not learning; that distinction is load-bearing.

### 2.3 The difference, concretely

Instead of:

```
8 trades · 5 wins · 3 losses · ₹2,450
```

a research record holds:

```
Pattern: bullish breakout

Before breakout:  price above VWAP · EMA trend aligned
                  volume expanding · resistance broken · strong 5m close

Strategies:       ORB → PROFIT   EMA → PROFIT
                  Breakout → PROFIT   RSI → LOSS

After entry:      momentum continued 4 candles · target reached

Conclusion:       favourable for trend-following,
                  unsuitable for mean-reversion
```

with every clause traceable to stored, measurable evidence.

---

## 3. R&D internal topology — `PROPOSED`

R&D carries the distributed, asynchronous personality described in [ARCHITECTURE_DECISION.md §2](ARCHITECTURE_DECISION.md). Unlike the Trading Core, it is a job-queue architecture from the start:

```
                    Research API
                         │
                    Job Queue
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
 Pattern Worker    Replay Worker    Backtest Worker
        │                │                │
        └────────────────┼────────────────┘
                         ▼
                    Research DB
                         │
                         ▼
                     AI Agent
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
             RAG        LLM    Research Tools
```

This matches how the workload actually behaves. When the AI proposes 500 parameter combinations, that is 500 queued jobs spread across one worker or twenty — scaled independently, with no effect on Live trading.

The infrastructure already anticipates this: [packages/redis/src/client.ts](../../packages/redis/src/client.ts) opens a dedicated `blocking` connection configured for BullMQ (`maxRetriesPerRequest: null`, `enableReadyCheck: false`), currently unused.

Deployment starts as `neelkanth-rnd` (API + worker in one project) and splits into `apps/research-api` / `apps/research-worker` / `apps/research-ai` when the triggers in [ARCHITECTURE_DECISION.md §14](ARCHITECTURE_DECISION.md) are met.

---

## 4. Phases — `DECIDED` (ordering) / `PROPOSED` (content)

Sixteen phases in strict dependency order. **This numbering is canonical.** Phases 0–4 contain no research at all — they are plumbing, and that is the point.

### Phase 0 — Verify repository state and aggregator integrity

**Implementation target, part one:** determine what actually exists, against the working branch, using the status vocabulary `EXISTS` / `PARTIALLY EXISTS` / `BROKEN` / `MISSING`. Never against a ZIP export, a stale clone or a previous conversation.

Output: [CURRENT_STATE.md](CURRENT_STATE.md), re-verified.

**Implementation target, part two:** repair live candle integrity before any historical data is written. Specifically, the aggregator is never flushed at session close ([CURRENT_STATE.md §5.1](CURRENT_STATE.md)), so the final partial bar of every session is lost and open bars carry across days in memory.

**This is a hard prerequisite for Phase 1, not a parallel task.** Backfilling historical data over a still-broken aggregator creates two data-quality problems at the same time, in the same collection, where each masks the other: the missing bar gets silently filled by broker data, and any discrepancy between the two sources becomes impossible to attribute. Debugging is already sufficiently capable of ruining an afternoon without assistance.

The ordering is therefore:

```
Verify repo → Fix aggregator flush → Phase 1 ingestion
→ Validate historical + live candle coexistence
```

That last step is part of Phase 1's acceptance, not an afterthought — see [../design/PHASE_1_HISTORICAL_DATA.md §9](../design/PHASE_1_HISTORICAL_DATA.md).

#### Scope fence — what the flush repair must not become

The flush repair is a narrow correctness fix: the aggregator is flushed at session close, the final bar of each session is persisted, and open bars do not carry across days. Nothing else.

It must **not** absorb any of the following, each of which belongs to its own phase:

| Not in Phase 0                                        | Belongs to          |
| ----------------------------------------------------- | ------------------- |
| Historical ingestion                                  | Phase 1             |
| Candle schema redesign, including `source` provenance | Phase 1 (design D2) |
| Replay work                                           | Phase 4             |
| Trade entity implementation                           | Phase 2             |
| Strategy changes                                      | Not scheduled       |
| Redis refactor                                        | Not scheduled       |

A fix that touches the session-flush path and stops there is reviewable in an afternoon and provably correct. The same fix carrying a schema change and a new ingestion path is neither, and it reintroduces exactly the entanglement this phase ordering exists to prevent. If the repair appears to require one of the rows above, that is a finding to record — not a licence to widen the branch.

### Phase 1 — Historical market data

**Prerequisite:** Phase 0 complete, including the aggregator flush fix.

**Implementation target:** introduce historical 5-minute market-data ingestion and establish the canonical research candle dataset.

Design: [../design/PHASE_1_HISTORICAL_DATA.md](../design/PHASE_1_HISTORICAL_DATA.md).

Pipeline:

```
Historical Market Data → Normalise → Validate → Store → Replay
```

Each stored candle carries symbol, exchange, interval, timestamp, OHLC, volume where valid, **source**, timezone and ingestion version. The research system must always know whether a candle came from a broker historical endpoint, live tick aggregation, or replay.

```
LIVE_TICK   BROKER_HISTORICAL   REPLAY   IMPORTED_DATA
```

Data sources are never silently mixed. Also required here: a date-range candle query, which does not exist today.

### Phase 2 — Trade lifecycle

**Implementation target:** create the canonical completed-trade record.

```
Entry → Active Trade → Exit → Completed Trade
```

Fields and exit reasons are specified in [ARCHITECTURE_DECISION.md §9.2](ARCHITECTURE_DECISION.md). Without this record there are no outcome labels, and every downstream phase is unfounded.

### Phase 3 — Exit model

**Implementation target:** ensure every simulated entry can eventually produce an outcome — stop loss, take profit, strategy exit, time exit, session square-off.

`Pattern → Strategy → Outcome` becomes a valid dataset only once an entry is guaranteed to terminate.

### Phase 4 — Deterministic replay

**Implementation target:** reuse and parameterise the existing golden pipeline rather than building a second, unrelated replay engine.

Replay must read historical candles, rebuild indicator state, rebuild strategy state, generate signals, simulate entries, simulate exits, produce completed trades, calculate outcomes, and remain deterministic across runs.

Replay is **read-only** against production trading collections. It never creates real orders, positions, broker events or live signals in the Live database.

**Strategy isolation — `DECIDED`.** For comparison, strategies run independently:

```
Replay A → Strategy A only
Replay B → Strategy B only
Replay C → Strategy C only
```

A combined portfolio simulation is a separate, later exercise. Running strategies together first measures the shared capital and risk engine rather than the strategies.

### Phase 5 — Pattern vocabulary

**Implementation target:** a small, versioned, deterministic detector library.

Starting set:

```
ORB_BREAKOUT   EMA_CROSS   RSI_REVERSION
VWAP_RECLAIM   HIGH_VOLUME_BREAKOUT
```

Each detector is hand-coded and deterministic, not learned or clustered. See §5.1 for the versioning rule that makes prior research survive a redefinition.

### Phase 6 — Counterfactual strategy evaluation

**Implementation target:** evaluate every strategy against the same historical market, whether or not it traded.

```
Pattern
 ├── ORB
 ├── EMA
 ├── RSI
 ├── MACD
 └── …
```

This is where "which strategy works with this pattern" acquires evidence rather than opinion. It requires the cost-model versioning in §5.3; without it, the comparison is decorative.

### Phase 7 — Statistical research engine

**Implementation target:** the gate that prevents "Strategy X won 78%!" from becoming a conclusion drawn from nine trades.

Rules in §5.2.

### Phase 8 — Daily research

**Implementation target:** per-instrument, per-trading-day analysis of the complete 5-minute candle sequence.

For each day: load the full candle sequence, preserve OHLCV and session information, compute features, analyse candle-by-candle behaviour, detect patterns, record which strategies signalled, link signals to their exact candle window, link actual orders to the same window, analyse candles from entry to exit, determine conditions preceding profits and losses, compare one pattern across multiple strategies, produce chart specifications, and store structured observations and evidence.

### Phase 9 — Weekly / monthly / quarterly research

**Implementation target:** aggregate daily evidence across trading windows.

| Window    | Questions                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Weekly    | Which patterns recurred? Which strategies worked with them? Which failed repeatedly, and under what conditions? Do findings repeat across days?                          |
| Monthly   | Which weaknesses recur? Which patterns were most profitable? Which caused the largest losses? Did behaviour change across regimes? Which hypotheses deserve backtesting? |
| Quarterly | Are monthly findings still valid across regimes? Are they robust or overfit? Does a proposed improvement survive different periods?                                      |

Windows are resolved against the trading calendar (§5.5), never wall-clock dates.

### Phase 10 — Research knowledge base

**Implementation target:** structured data, documents and chart specifications, searchable — pattern retrieval, strategy history, experiment history.

### Phase 11 — AI research agent

**Implementation target:** tool calling over the research dataset. **Only now.**

### Phase 12 — Automated strategy hypothesis

**Implementation target:** AI proposes candidates, registered as hypotheses before any test is run.

### Phase 13 — Backtest + walk-forward

**Implementation target:** candidate validation against out-of-sample data.

### Phase 14 — Paper validation

**Implementation target:** real-time simulated trading of a validated candidate.

### Phase 15 — Promotion

**Implementation target:** the controlled bridge to real money.

```
Research → Candidate → Historical validation → Walk-forward
→ Paper → Promotion candidate → Approval → Live
```

### 4.1 The agreed chain

One numbering, no compressed variant. Phases 0–11 are the chain to the first AI research agent:

```
 0. Verify repo + aggregator integrity
        ↓
 1. Historical 5m ingestion
        ↓
 2. Trade entity + lifecycle
        ↓
 3. Exit lifecycle
        ↓
 4. Deterministic replay
        ↓
 5. Pattern vocabulary
        ↓
 6. Counterfactual strategy evaluation
        ↓
 7. Statistical validation
        ↓
 8. Daily R&D
        ↓
 9. Weekly / monthly / quarterly R&D
        ↓
10. Research knowledge base
        ↓
11. AI research agent
```

Phases 12–15 — automated hypothesis, backtest and walk-forward, paper validation, promotion — continue unchanged past the end of this chain.

Everything from Phase 7 onward is downstream of having trustworthy evidence.

---

## 5. The seven research rules — `DECIDED`

These are mandatory, not nice-to-have. Each exists because its absence silently invalidates research that looks fine.

### 5.1 Versioned pattern vocabulary

Every detector carries:

```
patternId
detectorVersion
definition
parameters
```

If the definition of `ORB_BREAKOUT` changes in six months, research produced under the old definition remains reproducible and remains correctly labelled. Without this, every redefinition silently corrupts the entire history.

This is also why chart specifications beat stored images (§7): a versioned detector can re-render its own evidence.

### 5.2 Statistical gate

Every research finding carries:

```
hypothesisId
sampleSize
dateRange
instrumentCount
regime
costModelVersion
exitModelVersion
detectorVersion
```

**A strategy candidate cannot be created from an unregistered hypothesis.** Registration precedes the test, not the result — a hypothesis registered after seeing the outcome is not a hypothesis, it is a description.

The reason this rule needs teeth: one instrument produces roughly 75 five-minute bars per trading day and roughly 250 trading days per year. Pattern-conditional statistics are therefore computed on small samples, across many simultaneous comparisons. Without a registry and a minimum sample size, the system becomes an efficient generator of confident nonsense.

```
90% win rate
10 trades
```

is not evidence. Sample size is displayed with every result, always.

### 5.3 Counterfactual cost model

Every replay declares:

```
positionSizingVersion
exitModelVersion
slippageModelVersion
transactionCostVersion
```

Without these, "ORB 78% vs RSI 43%" compares two things that were never measured the same way. Reusable pieces already exist: [packages/broker/src/slippage.ts](../../packages/broker/src/slippage.ts) and [packages/broker/src/charges.ts](../../packages/broker/src/charges.ts).

### 5.4 Lookahead prevention

Every feature must satisfy:

```
Feature(t) = f( candles ≤ t )
```

never:

```
Feature(t) = f( candles > t )
```

Enforced in code and tests, not left to developer memory. A precedent already exists in the codebase: the Exit Engine evaluates stops and targets against **closed bars only**, for exactly this reason.

### 5.5 Trading calendar

Research periods understand Trading Day, Trading Week, Trading Month and Trading Quarter — resolved against `marketHolidays` in the global settings document ([packages/db/src/settings-repository.ts](../../packages/db/src/settings-repository.ts)), never raw calendar timestamps. A "week" containing a market holiday is four trading days, and aggregations that assume five are wrong in a way that is very hard to see.

### 5.6 F&O continuity

For derivatives:

```
NIFTY FUT JUN → NIFTY FUT JUL → NIFTY FUT AUG
```

cannot be treated as one continuous instrument without an explicit rollover rule — which contract, on which day, with what price adjustment. Required before any derivative research window exceeds a single expiry. Quarterly research on an unadjusted option or futures series is meaningless.

### 5.7 Data revision policy

If a candle changes after ingestion — a correction, a backfill, a re-fetch — the system must be able to answer: **which research records depended on it?**

Then:

```
INVALIDATE → RECOMPUTE → NEW RESEARCH VERSION
```

Research evidence is immutable; a revision produces a new version rather than editing the old one. This is what makes research reproducible rather than merely stored.

---

## 6. Data model — `PROPOSED`

### 6.1 Collections

```
candles                 patterns              pattern_observations
strategy_candidates     strategy_experiments  backtests
walk_forward_results    research_reports      ai_analysis
documents               embeddings
```

Daily, weekly, monthly and quarterly research are **one** `research_reports` collection distinguished by a `period` field — not four collections. Do not create multiple collections that duplicate one concept.

### 6.2 The critical relationship

```
Pattern → Pattern Occurrence → Market Context → Strategy
   → Signal → Order → Trade → Outcome
```

This chain is the foundation of the R&D engine. Every link must be a real, queryable reference — not an inference from timestamps.

### 6.3 Example research record

```json
{
  "date": "2026-09-09",
  "symbol": "NIFTY",
  "timeframe": "5m",

  "pattern": { "id": "P-027", "type": "breakout", "detectorVersion": "1.2.0" },

  "marketContext": {
    "trend": "bullish",
    "volatility": "high",
    "volume": "expanding",
    "priceVsVWAP": "above"
  },

  "strategyEvaluations": {
    "ORB": { "signal": "BUY", "result": "PROFIT" },
    "EMA": { "signal": "BUY", "result": "PROFIT" },
    "RSI": { "signal": "BUY", "result": "LOSS" }
  },

  "trade": { "side": "BUY", "entry": "…", "exit": "…", "result": "PROFIT" },

  "provenance": {
    "dataSource": "BROKER_HISTORICAL",
    "costModelVersion": "1.0.0",
    "exitModelVersion": "1.0.0",
    "positionSizingVersion": "1.0.0",
    "slippageModelVersion": "1.0.0"
  },

  "research": {
    "hypothesisId": "H-0042",
    "sampleSize": 37,
    "observations": [],
    "successFactors": [],
    "failureFactors": []
  },

  "artifacts": ["chartspec-P027"]
}
```

---

## 7. Chart research — `DECIDED`

**PNG screenshots are not the source of truth.** Store a chart _specification_ and render on demand:

```
symbol · interval · start · end
overlays:  EMA20, EMA50, VWAP
markers:   pattern, signal, entry, exit
annotations
```

Benefits: charts regenerate, detector definitions can change without stale images, less storage, easier comparison, and every visual artifact stays tied to a stable ID linking it to its structured research data.

Object storage for generated visual artifacts may be added later. It does not become the evidence.

---

## 8. What "good" looks like — `DECIDED`

### 8.1 Metrics

Never optimise for win rate alone. Measure:

```
Total Return      Net Return        Sharpe Ratio      Sortino Ratio
Maximum Drawdown  Profit Factor     Expectancy        Win Rate
Average Win       Average Loss      Trade Count       Avg Holding Time
Slippage          Transaction Costs Stability         Regime Dependence
```

Every result states sample size, date range, market regime, cost assumptions, slippage and out-of-sample performance.

### 8.2 Walk-forward validation

Never optimise and test on the same data.

```
Historical Data
├── Training window   → strategy development, parameter selection
└── Out-of-sample test window → evaluation
```

The window moves forward repeatedly. This is the primary defence against overfitting, and it is required before serious promotion.

### 8.3 Strategy improvement discipline

AI may propose:

```
EMA v1 → observed repeated failure
       → hypothesis: add ADX + volume filter
       → EMA v2 candidate
```

AI may **not** decide that v2 is better. Validation follows:

```
Candidate → Historical backtest → Transaction costs → Slippage
→ Out-of-sample → Walk-forward → Risk analysis
→ Compare against current strategy → Paper trading → Approval
```

Never promote on one good day or a small sample.

---

## 9. AI research platform — `PROPOSED`

AI is added only after the research dataset is trustworthy.

```
Research Dashboard → Research API → AI Agent → Tool Calling
    ├── Market data          ├── Strategy performance
    ├── Historical data      ├── Trade history
    ├── Indicators           ├── Backtest
    ├── Pattern data         ├── Walk-forward
    └── News                 └── RAG
```

### 9.1 Responsibilities

| Area                | AI may                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Research            | Analyse market behaviour, compare strategies, identify recurring and failed setups, explain historical relationships |
| Strategy research   | Generate hypotheses, suggest parameter changes, propose structures, identify regimes where strategies fail           |
| Validation          | Request backtests and walk-forward tests, compare candidates, analyse stability                                      |
| Knowledge retrieval | Retrieve similar historical patterns, previous experiments, strategy history, previous failures                      |

AI output is structured:

```
Hypothesis · Evidence · Date Range · Sample Size · Strategies Compared
Performance · Risk · Market Regimes · Confidence · Recommendation
```

### 9.2 RAG is memory, not evidence

RAG stores research documents, strategy versions, backtest and walk-forward reports, pattern studies, trade journals, market regimes, news research, AI analyses and strategy decisions — so the agent can retrieve similar historical situations.

The actual evidence always remains the structured research data. RAG points at it; it does not replace it.

### 9.3 Technology progression — `DEFERRED`

```
AI-0  Historical dataset        AI-8   Strategy optimisation
AI-1  Daily market analysis     AI-9   LangGraph
AI-2  Pattern/trade analysis    AI-10  MCP
AI-3  Research knowledge base   AI-11  Paper strategy promotion
AI-4  Tool-calling agent        AI-12  Specialised small models
AI-5  Strategy research agent   AI-13  Fine-tuning
AI-6  Automated backtesting     AI-14  Production AI platform
AI-7  Walk-forward validation
```

Do not start with fine-tuning. Do not train a small model from scratch — that is a far-later research project, not an early requirement. LangGraph enters when the workflow is genuinely multi-step and stateful; MCP enters when there are enough tools and services to justify a standardised interface. Build the clean dataset first.

---

## 10. Definition of done — first version — `DECIDED`

The first R&D version is complete when the system can:

- Reconstruct a historical trading day from 5-minute candles.
- Analyse the candle sequence.
- Detect and store meaningful patterns with detector versions.
- Store the market context surrounding each pattern.
- Identify which strategies generated signals.
- Link actual BUY/SELL trades to the relevant market window.
- Determine what happened after each signal.
- Store both successful and failed pattern examples.
- Produce chart specifications.
- Store structured research and visual specifications together.
- Generate a daily R&D report.
- Aggregate daily research into weekly, monthly and quarterly research using the trading calendar.
- Retrieve historical patterns and their outcomes.
- Generate research hypotheses without changing production strategy.
- Reproduce every research result from stored data.

---

## 11. Final vision — `DECIDED`

```
OBSERVE → RECORD → UNDERSTAND → COMPARE → DISCOVER
   → RESEARCH → TEST → VALIDATE → IMPROVE → OBSERVE AGAIN
```

The most valuable long-term dataset is:

```
5m Candle Sequence + Market Context + Chart Pattern + Strategy
+ Signal + BUY/SELL + Entry + Exit + Outcome + Chart Specification
```

which eventually allows:

> "We are seeing a pattern similar to P-027. Which strategies historically worked with this pattern, which failed, and under what conditions?"

That question, answerable from evidence rather than impression, is the entire point.

---

## Related documents

- [ARCHITECTURE_DECISION.md](ARCHITECTURE_DECISION.md) — architectural authority
- [CURRENT_STATE.md](CURRENT_STATE.md) — what exists today, and every known gap
- [../README.md](../README.md) — documentation index and the `plan/NN` citation bridge
