# Algo Trade --- AI Agent & Market R&D Plan

## 1. Purpose

Build an AI-powered Market R&D system that continuously studies
historical and daily market behavior, especially 5-minute candles, chart
patterns, strategy behavior, and actual BUY/SELL outcomes.

The AI should discover:

-   Why a particular market pattern worked.
-   Which strategies worked with that pattern.
-   Which strategies failed with the same pattern.
-   Under which market conditions each strategy works or fails.
-   Whether the same pattern has appeared historically.
-   What strategy improvements are worth testing.

This is **not** a generic daily P&L report and not an LLM directly
controlling the broker.

------------------------------------------------------------------------

## 2. Core Learning Loop

``` text
Market Data
    ↓
5-Minute Candle Analysis
    ↓
Chart / Market-Structure Analysis
    ↓
Pattern Detection
    ↓
Strategy Evaluation
    ↓
Actual BUY / SELL
    ↓
Trade Outcome
    ↓
Daily R&D
    ↓
Historical Pattern Knowledge
    ↓
Weekly / Monthly / 3-Month Analysis
    ↓
Strategy Improvement Hypothesis
    ↓
Backtest
    ↓
Walk-Forward Validation
    ↓
Candidate Strategy Version
```

------------------------------------------------------------------------

## 3. Daily R&D: What Must Happen

For every trading day and instrument:

1.  Load the complete 5-minute candle sequence.
2.  Preserve OHLCV and session information.
3.  Calculate relevant indicators and market features.
4.  Analyze candle-by-candle price behavior.
5.  Detect meaningful patterns and market structures.
6.  Record when a strategy generated a signal.
7.  Link the signal to the exact candle window.
8.  Link actual BUY/SELL orders to the same market window.
9.  Analyze candles after entry until exit.
10. Determine what conditions existed before profitable and losing
    trades.
11. Compare the same pattern against multiple strategies.
12. Generate chart snapshots for important patterns and trades.
13. Store structured observations and evidence.
14. Generate a daily R&D record that can be retrieved later.

### Example

Instead of:

``` text
8 trades
5 wins
3 losses
₹2,450 profit
```

the R&D record should contain:

``` text
Pattern: Bullish breakout

Before breakout:
- Price above VWAP
- EMA trend aligned
- Volume expanding
- Resistance broken
- Strong 5m close

Strategies:
- ORB → PROFIT
- EMA → PROFIT
- Breakout → PROFIT
- RSI → LOSS

After entry:
- Momentum continued for 4 candles
- Price reached target

Research conclusion:
This pattern historically appears favorable for
trend-following strategies but may be unsuitable
for mean-reversion strategies.
```

The conclusion must be based on measurable stored evidence.

------------------------------------------------------------------------

## 4. Pattern → Strategy → Outcome Learning

This is the most important part of the R&D system.

The system must not learn only:

``` text
EMA = profitable
```

It should learn:

``` text
Pattern A
    +
Market Context
    +
Strategy
    ↓
Outcome
```

Example:

``` text
Pattern A

ORB          → 78% profitable
EMA          → 71% profitable
Breakout     → 74% profitable
RSI          → 43% profitable
Mean Reversion → 31% profitable
```

Then investigate **why**.

Possible explanation:

``` text
Pattern A:
- Strong trend
- Volume expansion
- Price above VWAP
- Breakout continuation

Therefore:
Trend-following strategies work better.
Mean-reversion strategies fail more often.
```

The same system must learn failure patterns.

Example:

``` text
EMA BUY

EMA crossover
+
Low volume
+
Weak ADX
+
Resistance nearby
+
Sideways market
    ↓
False signal
    ↓
LOSS
```

After enough historical examples, this becomes a research hypothesis:

> EMA crossover may require stronger trend/volume confirmation in this
> type of market.

It must then be tested rather than automatically accepted.

------------------------------------------------------------------------

## 5. Historical Learning Windows

### Daily

Analyze:

-   Every 5-minute candle.
-   Detected patterns.
-   Strategy signals.
-   Actual orders.
-   Entry/exit behavior.
-   Profitable setups.
-   Losing setups.
-   Chart examples.

Output:

``` text
Daily Research Record
+
Pattern Examples
+
Trade Analysis
+
Chart Snapshots
```

### Weekly

Combine approximately one trading week of data.

Questions:

-   Which patterns appeared repeatedly?
-   Which strategies worked with them?
-   Which strategies repeatedly failed?
-   What conditions caused failures?
-   Are the same findings appearing across multiple days?

Output:

``` text
Weekly Pattern/Strategy Relationships
+
Recurring Findings
+
Research Hypotheses
```

### Monthly

Analyze the full month.

Questions:

-   Which strategy weaknesses repeatedly appeared?
-   Which patterns were most profitable?
-   Which patterns caused the largest losses?
-   Did strategy behavior change between market regimes?
-   Which hypotheses deserve backtesting?

Output:

``` text
Monthly R&D Report
+
Strategy Weaknesses
+
Pattern Statistics
+
Candidate Improvements
```

### 3 Months

Use a larger rolling dataset.

Questions:

-   Are monthly findings still valid?
-   Do they work across different market regimes?
-   Are the findings robust or overfit?
-   Does a proposed strategy improvement survive different periods?

Output:

``` text
Long-Term Pattern Knowledge
+
Strategy Robustness Analysis
+
Research Candidates
```

------------------------------------------------------------------------

## 6. Chart and Visual Memory

Visual evidence is a first-class R&D artifact.

For important patterns, store:

``` text
Full session chart
        +
Pattern-specific chart crop
        +
Indicators
        +
BUY/SELL marker
        +
Entry
        +
Exit
        +
Outcome
```

Example storage:

``` text
research/
└── 2026/
    └── 09/
        └── 09/
            └── NIFTY/
                ├── full-session.png
                ├── pattern-P027.png
                ├── trade-T1024.png
                └── research.json
```

Every visual artifact should have a stable ID linking it to structured
research data.

This allows future retrieval such as:

``` text
Show profitable ORB breakout examples
from the last 3 months.
```

The system should retrieve both:

-   Structured historical evidence.
-   Actual chart examples.

------------------------------------------------------------------------

## 7. Data Model

At minimum, the R&D system should eventually contain:

``` text
market_candles
market_features
detected_patterns
pattern_occurrences
strategy_evaluations
orders
trades
trade_outcomes
pattern_strategy_outcomes
daily_research
weekly_research
monthly_research
quarterly_research
strategy_hypotheses
strategy_experiments
strategy_versions
research_artifacts
```

### Critical relationship

``` text
Pattern
   ↓
Pattern Occurrence
   ↓
Market Context
   ↓
Strategy
   ↓
Signal
   ↓
Order
   ↓
Trade
   ↓
Outcome
```

This relationship is the foundation of the R&D engine.

------------------------------------------------------------------------

## 8. Example Research Record

``` json
{
  "date": "2026-09-09",
  "symbol": "NIFTY",
  "timeframe": "5m",

  "pattern": {
    "id": "P-027",
    "type": "breakout"
  },

  "marketContext": {
    "trend": "bullish",
    "volatility": "high",
    "volume": "expanding",
    "priceVsVWAP": "above"
  },

  "strategyEvaluations": {
    "ORB": {
      "signal": "BUY",
      "result": "PROFIT"
    },
    "EMA": {
      "signal": "BUY",
      "result": "PROFIT"
    },
    "RSI": {
      "signal": "BUY",
      "result": "LOSS"
    }
  },

  "trade": {
    "side": "BUY",
    "entry": "...",
    "exit": "...",
    "result": "PROFIT"
  },

  "research": {
    "observations": [],
    "successFactors": [],
    "failureFactors": [],
    "hypotheses": []
  },

  "artifacts": [
    "pattern-P027.png"
  ]
}
```

------------------------------------------------------------------------

## 9. AI Agent Responsibilities

The future AI/R&D system can be divided into specialized
responsibilities:

### Market Research Agent

Reads:

-   Candles
-   Indicators
-   Market features
-   Historical context

Produces structured market observations.

### Pattern Analysis Agent

Finds:

-   Breakouts
-   Rejections
-   Reversals
-   Consolidations
-   Trend structures
-   Volume patterns
-   Repeated candle structures
-   Other statistically meaningful patterns

### Trade Analysis Agent

Connects:

``` text
Pattern
→ Signal
→ Order
→ Entry
→ Exit
→ Result
```

and investigates why the trade worked or failed.

### R&D Agent

Compares historical evidence and discovers recurring relationships.

### Strategy Research Agent

Generates candidate strategy improvements.

### Report Agent

Creates:

-   Daily research
-   Weekly research
-   Monthly research
-   3-month research

------------------------------------------------------------------------

## 10. Recommended Architecture

``` text
Next.js Dashboard
        ↓
Node.js / Fastify API
        ↓
AI / R&D Service
        ↓
Tool Calling
        ↓
┌─────────────────────────────┐
│ Market Data                  │
│ Historical Candles           │
│ Indicators                   │
│ Pattern Data                 │
│ Orders / Trades              │
│ Strategy Performance         │
│ Chart Generator              │
│ Backtester                   │
└─────────────────────────────┘
        ↓
R&D Knowledge Store
        ↓
RAG
        ↓
LLM / AI Agent
```

### LangGraph

Use LangGraph when the workflow becomes multi-step/stateful, for
example:

``` text
Retrieve data
    ↓
Analyze market
    ↓
Find patterns
    ↓
Analyze strategies
    ↓
Compare historical examples
    ↓
Generate hypothesis
    ↓
Run experiment
    ↓
Generate research result
```

### MCP

Introduce MCP later when the project has many tools/services that
benefit from a standardized tool interface.

### Fine-tuning

Do not start with fine-tuning.

First build a clean dataset.

### Small model

Later, specialized models could handle tasks such as:

-   Market-regime classification.
-   Pattern classification.
-   News classification.
-   Strategy ranking.

### LLM

Use the LLM primarily for:

-   Research reasoning.
-   Explanation.
-   Hypothesis generation.
-   Historical research synthesis.

------------------------------------------------------------------------

## 11. Strategy Improvement Rules

The AI can propose:

``` text
EMA v1
    ↓
Observed repeated failure
    ↓
Hypothesis:
Add ADX + volume filter
    ↓
EMA v2 candidate
```

But the AI must NOT automatically decide that v2 is better.

Validation must follow:

``` text
Candidate Strategy
       ↓
Historical Backtest
       ↓
Transaction Costs
       ↓
Slippage
       ↓
Out-of-Sample Test
       ↓
Walk-Forward Test
       ↓
Risk Analysis
       ↓
Compare Against Current Strategy
       ↓
Paper Trading
       ↓
Strategy Approval
```

Evaluate more than win rate:

-   Expectancy
-   Profit factor
-   Max drawdown
-   Sharpe/Sortino where appropriate
-   Trade count
-   Stability
-   Slippage sensitivity
-   Transaction costs
-   Performance across market regimes
-   Out-of-sample performance

Never promote a strategy because of one good day or a small sample.

------------------------------------------------------------------------

## 12. Implementation Phases

### Phase 1 --- R&D Data Foundation

Build:

-   5-minute candle storage.
-   Market feature storage.
-   Pattern schema.
-   Strategy evaluation schema.
-   Trade linkage.
-   Research artifact schema.

### Phase 2 --- Daily R&D Engine

Build:

-   Candle-by-candle analysis.
-   Pattern detection.
-   Strategy mapping.
-   Trade analysis.
-   Daily research generation.

### Phase 3 --- Visual Research

Build:

-   Full-session charts.
-   Pattern crops.
-   Entry/exit markers.
-   Pattern snapshots.
-   Research artifact storage.
-   Dashboard viewer.

### Phase 4 --- Historical Learning

Build:

-   Weekly aggregation.
-   Monthly aggregation.
-   3-month aggregation.
-   Pattern/strategy statistics.
-   Recurring pattern detection.

### Phase 5 --- AI Agent + RAG

Build:

-   Tool calling.
-   Research retrieval.
-   Structured AI analysis.
-   R&D reports.
-   Historical pattern retrieval.

### Phase 6 --- Strategy Research

Build:

-   Research hypotheses.
-   Candidate strategy generation.
-   Experiment tracking.
-   Strategy comparison.

### Phase 7 --- Validation

Build:

-   Backtesting.
-   Walk-forward testing.
-   Robustness checks.
-   Risk gates.
-   Strategy versioning.

### Phase 8 --- Continuous Feedback

``` text
Production / Paper Trading
        ↓
New Market Data
        ↓
New Trades
        ↓
Daily R&D
        ↓
Historical Dataset
        ↓
Strategy Research
        ↓
Validation
        ↓
Improved Candidate
```

------------------------------------------------------------------------

# 13. Tomorrow's First Implementation Plan

Do **not** immediately build the complete AI ecosystem.

First inspect the existing Algo Trade repository and build the R&D
foundation around the data already available.

### Task 1 --- Repository Audit

Identify the current:

-   Market-data flow.
-   5-minute candle flow.
-   Indicators.
-   Strategy engine.
-   Signals.
-   Orders.
-   Positions.
-   Trades.
-   P&L.
-   Database repositories.
-   Redis/event system.
-   WebSocket system.

### Task 2 --- Define R&D Schemas

Create canonical models for:

``` text
Candle
MarketFeature
Pattern
PatternOccurrence
StrategyEvaluation
TradeAnalysis
ResearchArtifact
DailyResearchReport
ResearchHypothesis
```

### Task 3 --- Link Trades to Market Context

Every actual trade must be traceable to:

``` text
Symbol
+
Timeframe
+
Entry candle
+
Previous candle window
+
Pattern
+
Strategy
+
Signal
+
Exit
+
Outcome
```

### Task 4 --- Build Read-Only Daily R&D

First version should analyze historical data without changing live
trading behavior.

### Task 5 --- Test One Historical Day

Take one complete trading day and prove:

``` text
5m candles
    ↓
Pattern detection
    ↓
Strategy evaluation
    ↓
Trade linkage
    ↓
Outcome
    ↓
Research record
```

### Task 6 --- Generate Chart Evidence

Create at least:

``` text
1 full-session chart
+
1 important pattern snapshot
+
1 trade snapshot
```

### Task 7 --- Store Everything

The same research should be reproducible from the stored data.

### Task 8 --- Add Retrieval

Support queries such as:

``` text
Find profitable ORB patterns.

Find EMA failures.

Find patterns where ORB worked but RSI failed.

Find similar NIFTY setups from the last 3 months.

Show chart examples of successful breakout patterns.
```

### Task 9 --- Only Then Add the AI Agent

Once the data foundation works:

``` text
Structured R&D Data
        ↓
Tools
        ↓
RAG
        ↓
AI Research Agent
```

------------------------------------------------------------------------

# 14. First-Version Definition of Done

The first R&D version is complete when the system can:

-   Reconstruct a historical trading day using 5-minute candles.
-   Analyze the candle sequence.
-   Detect/store meaningful patterns.
-   Store the market context surrounding each pattern.
-   Identify which strategies generated signals.
-   Link actual BUY/SELL trades to the relevant market window.
-   Determine what happened after the signal.
-   Store successful and failed pattern examples.
-   Generate chart snapshots.
-   Store structured research and visual artifacts together.
-   Generate a daily R&D report.
-   Aggregate daily research into weekly/monthly/3-month research.
-   Retrieve historical patterns and their outcomes.
-   Generate research hypotheses without changing production strategy.
-   Reproduce the research from stored data.

------------------------------------------------------------------------

# 15. Final Vision

The Algo Trade AI/R&D system should eventually behave like a
continuously growing research laboratory:

``` text
OBSERVE
   ↓
RECORD
   ↓
UNDERSTAND
   ↓
COMPARE
   ↓
DISCOVER
   ↓
RESEARCH
   ↓
TEST
   ↓
VALIDATE
   ↓
IMPROVE
   ↓
OBSERVE AGAIN
```

The most valuable long-term dataset is:

``` text
5m Candle Sequence
+
Market Context
+
Chart Pattern
+
Strategy
+
Signal
+
BUY/SELL
+
Entry
+
Exit
+
Outcome
+
Visual Chart
```

This allows the system to eventually answer questions such as:

> "We are seeing a pattern similar to P-027. Which strategies
> historically worked with this pattern, which failed, and under what
> conditions?"

That is the foundation for a genuinely useful AI-assisted trading R&D
system.

------------------------------------------------------------------------

## Tomorrow's priority

**Do not start with fine-tuning, training an LLM from scratch, or making
the AI autonomous.**

Start with:

``` text
5m historical data
        ↓
Pattern dataset
        ↓
Strategy/outcome dataset
        ↓
Chart snapshots
        ↓
Daily R&D
        ↓
Historical knowledge
        ↓
AI Agent
```

The dataset comes first. The intelligence layer comes on top of it.
