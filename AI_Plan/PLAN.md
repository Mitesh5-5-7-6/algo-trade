The new PLAN.md

I would make it much simpler than your current documentation.

# Algo Trade Development Plan

> SINGLE EXECUTION PLAN
>
> This document is the only document that defines
> implementation order and the next engineering task.

---

# 1. Mission

Build a reliable algorithmic trading platform where:

Market Data
→ Candle
→ Indicator
→ Strategy
→ Signal
→ Risk
→ Order
→ Broker
→ Fill
→ Position
→ Trade
→ P&L
→ Research
→ AI

The system must establish trustworthy trading evidence before
introducing AI research automation.

---

# 2. Non-Negotiable Rules

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

# 3. Current Architecture

## Trading

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
R&D
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
AI
AI may:

READ
ANALYZE
COMPARE
RESEARCH
PROPOSE
REQUEST BACKTEST
REQUEST WALK-FORWARD
CREATE HYPOTHESIS

AI may NOT:

PLACE LIVE ORDER
BYPASS RISK
CHANGE KILL SWITCH
CHANGE LIVE LIMITS
APPROVE ITS OWN STRATEGY
4. Development Order

The project is executed strictly in this order.

PHASE 0
Repository + runtime integrity
        ↓
PHASE 1
Historical 5m data
        ↓
PHASE 2
Trade lifecycle
        ↓
PHASE 3
Exit lifecycle
        ↓
PHASE 4
Deterministic replay
        ↓
PHASE 5
Pattern vocabulary
        ↓
PHASE 6
Counterfactual strategy evaluation
        ↓
PHASE 7
Statistical validation
        ↓
PHASE 8
Daily research
        ↓
PHASE 9
Periodic research
        ↓
PHASE 10
Research knowledge base
        ↓
PHASE 11
AI research agent
        ↓
PHASE 12
Automated strategy hypotheses
        ↓
PHASE 13
Backtest + walk-forward
        ↓
PHASE 14
Paper validation
        ↓
PHASE 15
Promotion

No phase is skipped.

A later phase may only start when its dependency is complete.

5. Phase 0 — Repository + Runtime Integrity
Goal

Verify the real working branch and repair the runtime foundation.

Work
Inspect repository.
Verify existing market-data flow.
Verify candle aggregation.
Fix aggregator session flush.
Ensure the final partial candle is persisted.
Ensure bars do not carry across sessions.
Verify daily P&L survives restart.
Verify strategy state survives restart where required.
Verify broker reconciliation.
Run existing tests.
Done when
Market session closes cleanly.
Final candle is persisted.
No cross-session candle contamination.
Restart does not erase today's risk state.
Broker reconciliation works.
Existing tests remain green.
Do NOT
build historical ingestion
build AI
add strategies
refactor architecture

6. Phase 1 — Historical 5m Data
Goal

Create the canonical historical research dataset.

Work
Verify FYERS history API.
Implement HistoryProvider.
Implement pagination.
Normalize broker candles.
Validate OHLC/timestamps.
Add provenance.
Add trading-calendar handling.
Choose initial symbols.
Choose initial history depth.
Implement operator-triggered backfill.
Verify historical and LIVE_TICK data coexist.
Verify no duplicate candles.
Initial scope

Start small.

NIFTY
BANKNIFTY
5-minute
bounded historical period

Do not start with the entire F&O universe.

Done when

A known historical period can be loaded and queried reliably.

7. Phase 2 — Trade Lifecycle
Goal

Create the canonical completed Trade entity.

Lifecycle
Signal
 ↓
Order
 ↓
Fill
 ↓
Position
 ↓
Active Trade
 ↓
Exit
 ↓
Completed Trade
Trade must contain
tradeId
strategyId
strategyVersion
symbol
side
entryOrderId
entryTime
entryPrice
exitOrderId
exitTime
exitPrice
quantity
exitReason
grossPnL
charges
slippage
netPnL
entryPattern
market context
data provenance
Done when

Every completed position produces exactly one complete Trade.

8. Phase 3 — Exit Lifecycle
Goal

Every entry must be capable of reaching a deterministic outcome.

Exit types
STOP_LOSS
TAKE_PROFIT
STRATEGY_EXIT
TIME_EXIT
SESSION_CLOSE
MANUAL_EMERGENCY
BROKER_RECONCILIATION
Done when

Every simulated entry eventually produces:

ENTRY → EXIT → COMPLETED TRADE

No orphaned simulated entries.

9. Phase 4 — Deterministic Replay
Goal

Run the existing trading pipeline against historical candles.

Rule

The same:

dataset
+
strategy
+
parameters
+
seed

must produce the same result.

Replay must include
Market Data
→ Indicators
→ Strategy
→ Signal
→ Risk
→ Order
→ Fill
→ Position
→ Trade
→ P&L
Done when

Running the same replay twice produces identical results.

Replay must never modify Paper or Live trading state.

10. Phase 5 — Pattern Vocabulary
Goal

Create a small deterministic, versioned pattern library.

Initial patterns may include:

ORB_BREAKOUT
EMA_CROSS
RSI_REVERSION
VWAP_RECLAIM
HIGH_VOLUME_BREAKOUT
BREAKOUT
REJECTION
REVERSAL
CONSOLIDATION
TREND
GAP
RANGE

Each observation must include:

patternId
detectorVersion
timestamp
symbol
timeframe
marketContext
dataProvenance
Rules

Patterns are:

deterministic
reproducible
versioned
calculated only from information available at that time

No ML clustering yet.

11. Phase 6 — Counterfactual Strategy Evaluation
Goal

Determine how the same market pattern behaves across different strategies.

Example:

VWAP_RECLAIM
      ↓
┌───────────────┐
│ Strategy A    │
│ Strategy B    │
│ Strategy C    │
└───────────────┘

Evaluate:

occurrence count
entries
exits
win/loss
expectancy
drawdown
costs
slippage
market regime
Done when

Research can answer:

"When this pattern occurred, how did each strategy behave?"

12. Phase 7 — Statistical Validation
Goal

Prevent small samples and overfitting from becoming fake conclusions.

Requirements
hypothesis registry
minimum sample size
confidence/statistical rules
out-of-sample separation
multiple-comparison awareness
cost model
slippage model
parameter versioning

Never conclude:

78% win rate

without also knowing:

sample size
period
market regime
costs
slippage
out-of-sample status
13. Phase 8 — Daily Research
Goal

Automatically analyze each completed trading day.

For each day:

Load candles
 ↓
Compute features
 ↓
Detect patterns
 ↓
Find strategy signals
 ↓
Find trades
 ↓
Link entry → exit
 ↓
Analyze outcome
 ↓
Store evidence

Output:

Daily Research Report
Pattern Observations
Strategy Observations
Trade Evidence
Chart Specifications

No PNG is the source of truth.

14. Phase 9 — Weekly / Monthly / Quarterly Research

Aggregate daily evidence.

Weekly

Find recurring behavior.

Monthly

Find persistent weaknesses and opportunities.

Quarterly

Check whether findings survive different market regimes.

All windows use the trading calendar.

15. Phase 10 — Research Knowledge Base
Goal

Make accumulated research searchable.

Store:

research reports
patterns
pattern observations
strategy experiments
backtests
walk-forward results
trade evidence
documents
chart specifications
AI analysis

The knowledge base becomes the foundation for the AI agent.

16. Phase 11 — AI Research Agent
Goal

Build an AI that can reason over structured research evidence.

Initial tools
findPatterns()
strategyMatrix()
similarSessions()
tradeHistory()
newsContext()
runBacktest()
runWalkForward()
Agent can
investigate questions
summarize evidence
compare strategies
find recurring patterns
identify anomalies
propose hypotheses
request backtests
explain research findings
Agent cannot
place broker orders
bypass Risk Engine
change Live limits
disable safety systems
promote itself to Live

Every answer must include:

sample size
date range
strategy version
data version
cost assumptions
17. Phase 12 — Automated Strategy Hypothesis

Only after Phase 11.

AI may propose:

Hypothesis
    ↓
Registry
    ↓
Validation

A proposal is not automatically a strategy.

18. Phase 13 — Backtest + Walk-Forward

Every serious candidate must pass:

Historical Backtest
        ↓
Out-of-Sample
        ↓
Walk-Forward
        ↓
Cost/Slippage Validation

No direct promotion from AI suggestion to Live.

19. Phase 14 — Paper Validation

Candidate runs against real-time market data without real money.

Validate:

signals
execution
fills
slippage
risk
positions
exits
P&L
restart recovery
broker reconciliation
20. Phase 15 — Promotion

Promotion lifecycle:

Research
 ↓
Candidate
 ↓
Historical validation
 ↓
Walk-forward
 ↓
Paper
 ↓
Promotion candidate
 ↓
Human approval
 ↓
Live

Live requires every safety gate.

21. Strategy Development Rule

Adding strategies is NOT its own uncontrolled roadmap.

For every new strategy:

Strategy Definition
      ↓
Required Data
      ↓
Implementation
      ↓
Unit Tests
      ↓
Historical Replay
      ↓
Cost Model
      ↓
Statistical Validation
      ↓
Walk-Forward
      ↓
Paper

For option strategies additionally verify:

lot size
expiry
strike selection
OI
volume quality
IV
bid/ask spread
slippage
charges
liquidity
22. News Track

News is parallel data infrastructure.

Market Track
     │
     ├── Historical Data
     ├── Trade
     ├── Replay
     └── Research
     
News Track
     │
     ├── Ingestion
     ├── Classification
     └── Market linkage
     
     └──────────────┬──────────────┘
                    ↓
                 Research

News must not block the core market-data → trade → replay path.

23. What Claude Must Do Before Every Task

Before changing code:

Read this PLAN.md.
Identify the current phase.
Identify the exact task.
Read only the relevant architecture/spec sections.
Inspect the actual working branch.
Find existing implementation.
Reuse existing contracts.
Identify dependencies.
Implement only the current task.
Run relevant tests.
Report what changed.
Report what remains blocked.
24. What Claude Must NEVER Do

Do not:

jump to a later phase
build AI early
invent missing data
fabricate broker behavior
create duplicate architecture
create a second strategy framework
create duplicate repositories
rename the project
rename packages without explicit approval
rewrite working code unnecessarily
add microservices just for appearance
bypass Risk Engine
connect AI directly to broker
mark a task complete without acceptance evidence
25. Current Task

Claude must always end its planning analysis with:

CURRENT PHASE:
CURRENT TASK:
WHY THIS TASK:
DEPENDENCIES:
FILES TO INSPECT:
FILES TO CHANGE:
ACCEPTANCE TEST:
NEXT TASK:

Only one task should be actively implemented at a time.

26. Definition of Done

A phase is complete only when:

Implementation exists.
Tests exist.
Relevant tests pass.
Existing behavior is not unintentionally broken.
Acceptance criteria pass.
Documentation reflects the actual state.
No known blocker is hidden.
Git diff contains only related changes.

Then and only then:

PHASE N
   ↓
COMPLETE
   ↓
PHASE N+1
27. Current Priority

The immediate priority is:

PHASE 0
Repository + runtime integrity

After Phase 0:

PHASE 1
Historical 5m data

Do not begin Phase 2 until Phase 1's acceptance criteria pass.

Do not begin research phases until replay and Trade outcomes are trustworthy.

Do not build the AI research agent before the research knowledge base exists.

28. Source of Truth

Priority order:

This PLAN.md
ARCHITECTURE_DECISION.md
RND_RESEARCH_SPECIFICATION.md
Existing source code
Tests
Older planning documents

If two documents conflict:

PLAN.md wins for implementation order.

ARCHITECTURE_DECISION.md wins for architectural decisions.

RND_RESEARCH_SPECIFICATION.md wins for detailed research behavior.

Never silently choose between conflicting documents.
Report the conflict.


## This is the important part

I would **not** delete your architecture and R&D documents. They have useful information. The problem is that they are being used as execution plans.

Their roles should become:

```text
                    PLAN.md
                       │
              "WHAT DO I BUILD NOW?"
                       │
          ┌────────────┼────────────┐
          ↓            ↓            ↓
 CURRENT_STATE       ADR        RND SPEC
 "What exists?"   "Why?"       "How should
                               R&D behave?"
Claude's mental model becomes incredibly simple

Every time Claude starts:

1. Where am I?
2. What phase am I in?
3. What is the ONE task?
4. What already exists?
5. What files should I touch?
6. What proves I'm finished?

Not:

"Let me read 100 pages of architecture, discover three competing roadmaps, infer which phase is canonical, and then build an AI agent because the document mentioned one."

That is exactly the confusion you're seeing.

One more change I strongly recommend

Do not put "blocked" on the phase itself.

Use:

Phase 1
Status: READY / IN PROGRESS / COMPLETE

Task 1.1
Status: COMPLETE

Task 1.2
Status: IN PROGRESS

Task 1.3
Status: BLOCKED
Reason: FYERS vendor verification

So Claude knows:

PHASE 1 = current
TASK 1.3 = blocked

rather than interpreting:

PHASE 1 = blocked

as:

"Cool, let's work on Phase 7."

That distinction alone will make the workflow considerably less stupid.

The existing architecture already has the right underlying dependency chain, from historical data through Trade, exit, replay, patterns, statistics, research and finally AI. The fix is mainly to collapse execution authority into one readable plan, while keeping the architecture and research documents as supporting references.
