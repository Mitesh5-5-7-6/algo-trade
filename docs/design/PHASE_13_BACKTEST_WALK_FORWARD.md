# Phase 13 — Backtest + walk-forward

**Status: see [PLAN.md](../PLAN.md) §18.** Phase 13 is open; its task board
lives there and nowhere else. This document holds the decisions the board's
tasks implement.

Authorities: [PLAN.md](../PLAN.md) §18 for scope,
[RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md)
§8.1 (metrics), §8.2 (walk-forward: "never optimise and test on the same
data"), §8.3 (the validation chain), §5.2 ("a strategy candidate cannot be
created from an unregistered hypothesis"), §6.1 (`strategy_candidates`,
`backtests`, `walk_forward_results`);
[ARCHITECTURE_DECISION.md](../architecture/ARCHITECTURE_DECISION.md) §12
(promotion: RESEARCH → CANDIDATE → HISTORICAL VALIDATION → PAPER → …).

---

## 1. Goal

> Every serious candidate must pass `Historical Backtest → Out-of-Sample →
Walk-Forward → Cost/Slippage Validation`. No direct promotion from AI
> suggestion to Live.

A **candidate** — a replayable strategy and a declared set of parameter
variants, created from a registered hypothesis — is backtested with the
spec's full metric set, then walked forward: parameters chosen on each
training window only, tested on the window after it, under normal and
stressed costs, against the strategy's current configuration on the same
windows. A declared gate says PASS or FAIL. PASS makes a candidate eligible
for Phase 14's paper validation — nothing more: nothing here enables,
changes or promotes a strategy.

---

## 2. What exists

- **Deterministic replay** (Phase 4): one strategy, any parameters, over a
  date range of stored bars, under declared sizing, exit, slippage and
  charges models; a manifest naming everything the run is a function of; a
  trail of every Trade.
- **The registry** (Phase 7, 12): registered hypotheses, cells and variants;
  the strategies' own parameter check (Phase 12 F2).
- **Statistics** (Phase 7): `meanPValue`, `meanInterval`, `wilsonInterval`.
- **The regime model** (Phase 6) for regime dependence.

Nothing computes Sharpe, Sortino, profit factor or stability, and no
`strategy_candidates`, `backtests` or `walk_forward_results` collection exists.

### 2.1 The decisions taken at opening

**Q1 — the standard gate**, by the operator (D6).

**Q2 — rolling folds, three months' training, one month's test**, by the
operator (D4).

---

## 3. Design decisions

### D1 — A candidate is declared, from a registered hypothesis

`strategy_candidates`: `SC-NNNN`, a replayable strategy type, a grid of
parameter variants (one to twelve, each checked by the strategy's own schema
exactly as given — Phase 12 F2), the instruments, and the **registered
hypothesis** it comes from (spec §5.2) — refused for an unregistered one.
Declared once, never edited: the grid is fixed before any walk-forward runs,
so it cannot be widened after a result. Created by the operator.

### D2 — A backtest states everything §8.1 asks

Over one window and one parameter set, from the replay's Trades: total and
net return (on allocated capital), Sharpe and Sortino (daily net returns,
annualised over 252 sessions), maximum drawdown (amount and % of capital),
profit factor, expectancy (with its interval), win rate, average win and
loss, Trade count, average holding time, slippage and charges paid,
**stability** (net by calendar month, the share of profitable months) and
**regime dependence** (expectancy by regime at entry). Every backtest names
its sample size, date range, cost assumptions and the replay manifest behind
it. Kept in `backtests`, insert-only, fingerprinted.

### D3 — Cost stress is a second backtest, not a guess

The same window and parameters replayed with slippage ×2 and charges ×1.5: a
candidate whose edge disappears under plausibly worse costs has no edge.

### D4 — Walk-forward: parameters are chosen on the past only

Folds by calendar month: train on three complete months, test on the next
one, step one month (Q2) — on the stored year, nine test months, January to
September 2026. In each fold every variant of the grid is backtested on the
**training** window; the one with the highest training expectancy among
those with at least 30 Trades is chosen (ties: the grid's first); none
qualifying, the fold trades nothing and says so. Only the chosen variant is
run on the **test** window — the test window never informs a choice. The
strategy's **current configuration** (its defaults) runs on the same test
windows as the baseline. The test windows' Trades, concatenated, are the
candidate's out-of-sample record, measured as D2, and again under D3's
stress. Which variant each fold chose is recorded: a choice that flips every
month is itself a finding. Kept in `walk_forward_results`.

### D5 — Deterministic, and refused on an open window

The same candidate, folds and models give the same results and
fingerprints. A fold whose test month the stored data has not closed is not
run (Phase 12 D6's rule): a walk-forward covers only complete windows.

### D6 — The gate (Q1)

Out of sample, across the folds, net of costs — PASS only if all hold:

| Criterion                                       | Threshold                   |
| ----------------------------------------------- | --------------------------- |
| Trades                                          | ≥ 30                        |
| Expectancy per Trade                            | > 0, one-sided p < 0.05     |
| Profit factor                                   | > 1.1                       |
| Maximum drawdown                                | ≤ 10% of allocated capital  |
| Expectancy, slippage ×2 and charges ×1.5        | > 0                         |
| Against the current configuration, same windows | expectancy ≥ the baseline's |

Each criterion is reported with its value, whether it held, and the gate's
policy version. PASS makes the candidate eligible for Phase 14; FAIL says
which criteria failed. Neither changes any strategy.

---

## 4. Open decisions

| #   | Question      | Decided                                                                    |
| --- | ------------- | -------------------------------------------------------------------------- |
| Q1  | The pass gate | **Standard**, by the operator at opening (D6).                             |
| Q2  | The folds     | **Rolling, 3-month train, 1-month test**, by the operator at opening (D4). |

---

## 5. Proposed task order

| ID   | Task                                                                                                                                                     | Depends on |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 13.1 | Backtest metrics: the §8.1 set from a replay's Trades — returns, Sharpe, Sortino, drawdown, profit factor, expectancy, stability, regime dependence (D2) | —          |
| 13.2 | Backtests: a candidate's parameters over a window, normal and stressed costs, kept in `backtests` (D2, D3)                                               | 13.1       |
| 13.3 | Candidates: declared from a registered hypothesis, a checked grid, never edited (D1)                                                                     | —          |
| 13.4 | Walk-forward: monthly folds, choice on training only, the baseline on the same windows, kept (D4, D5)                                                    | 13.2, 13.3 |
| 13.5 | The gate: PASS or FAIL against the standard criteria, each with its value (D6)                                                                           | 13.4       |
| 13.6 | The CLI: candidates, backtests, walk-forward and the verdict                                                                                             | 13.5       |
| 13.7 | Acceptance: candidates from the registered hypotheses, walked forward over the real year, gated; determinism and no-lookahead shown                      | 13.6       |

---

## 6. Done when

A candidate declared from a registered hypothesis is backtested with every
§8.1 metric, walked forward over the stored year — parameters chosen on each
training window only, tested on the month after, under normal and stressed
costs, against the current configuration — and gated PASS or FAIL against the
declared criteria, each with its value; the results are deterministic and
kept; and nothing changes or promotes a strategy.

---

## Related documents

- [../PLAN.md](../PLAN.md) §18
- [PHASE_4_DETERMINISTIC_REPLAY.md](PHASE_4_DETERMINISTIC_REPLAY.md) — the replay a backtest runs
- [PHASE_12_AUTOMATED_HYPOTHESIS.md](PHASE_12_AUTOMATED_HYPOTHESIS.md) — where candidates come from
