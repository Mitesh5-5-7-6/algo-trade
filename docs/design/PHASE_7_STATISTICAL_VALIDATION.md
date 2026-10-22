# Phase 7 — Statistical validation

**Status: see [PLAN.md](../PLAN.md) §12.** Phase 7 is open; its task board
lives there and nowhere else. This document holds the decisions the board's
tasks implement.

Authorities: [PLAN.md](../PLAN.md) §12 for scope,
[RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md)
Phase 7, §5.2 (the statistical gate), §5.3 (cost-model versioning) and §8 for
research behaviour; [ARCHITECTURE_DECISION.md](../architecture/ARCHITECTURE_DECISION.md)
§10.1 for where records live.

---

## 1. Goal

> Prevent small samples and overfitting from becoming fake conclusions.
> Hypothesis registry, minimum sample size, confidence/statistical rules,
> out-of-sample separation, multiple-comparison awareness, cost model,
> slippage model, parameter versioning. Never conclude `78% win rate` without
> also knowing sample size, period, market regime, costs, slippage and
> out-of-sample status.

Phase 6 produces a matrix in which every cell is an observation with an `n`.
Phase 7 is the only door from an observation to a finding: a claim registered
before it is tested, tested once on data it was not formed on, held to a
minimum sample, judged with an interval and a p-value, and corrected for the
other claims tested beside it.

---

## 2. What exists

### 2.1 Nothing to port

No branch carries statistical code (`git grep` across `main`,
`docs/architecture-baseline`, `wip/phase-3-staged`; the hits are comments).
Phase 7 is built here, on Phase 6's counterfactual run.

### 2.2 What Phase 6 hands over, and what it lacks

| Has                                                                                                              | Lacks                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Per cell: `n`, wins, win rate, net, expectancy (per Trade and per unit), costs, slippage, drawdown, regime split | Any measure of dispersion — an expectancy cannot be given an interval without the spread of the Trades behind it |
| A manifest naming every model and version, and a fingerprint                                                     | Any notion of a claim, a window it was formed on, or a window it is tested on                                    |

### 2.3 Where records live

ADR §10.1 lists no hypothesis collection. A registered hypothesis is a
pre-registered experiment — its plan, fixed before it runs — and its test is
that experiment's result. Both are kept in `strategy_experiments`, the
collection Phase 6 already uses, as `kind: "HYPOTHESIS"` and
`kind: "HYPOTHESIS_TEST"`, rather than a new collection for the same concept.

---

## 3. Design decisions

### D1 — Statistics are a pinned, pure module

Wilson score interval for a rate; an exact one-sided binomial tail; the normal
CDF and quantile; a mean's interval and one-sided z-test; Holm's step-down
correction. Pure functions, deterministic, each pinned against published
reference values — a statistics bug is invisible in its own output, so the
numbers are checked against numbers computed elsewhere.

### D2 — A cell carries its dispersion

`TradeStats` gains the sample standard deviation of net per Trade and of net
per unit. `COUNTERFACTUAL_VERSION` becomes `2`: the matrix's shape changed, so
its fingerprints do, and the version says so. (Phase 6's recorded `1`
fingerprints stay true of version `1`.)

### D3 — A hypothesis is registered before it is tested, and is immutable

`H-NNNN`. It names one cell — pattern (or `ALL`), strategy, symbol, regime —
a metric (`winRate`, `expectancy`, `expectancyPerUnit`), a direction and a
threshold; its significance level `alpha` and minimum sample; an in-sample
window it was formed on and an out-of-sample window it will be tested on,
which must not overlap and must come after; its family (D6); and the versions
it is a claim about — strategy, detector, sizing, exit, slippage and
transaction-cost models, regime and attribution (spec §5.3, "parameter
versioning"). Its fingerprint is the canonical definition. Registered once,
never edited: a hypothesis edited after its result is a description.

### D4 — One test, on the out-of-sample window only

A hypothesis is tested exactly once (the test's id is the hypothesis id —
insert-once), after it was registered, on a counterfactual run of its
out-of-sample window. A run whose versions differ from those registered is
refused: it would test a different claim. The in-sample window is evaluated
too, and reported — descriptively, never as the verdict.

### D5 — The gate: minimum sample, interval, p-value

`n` below the minimum (never less than the policy floor of 30 Trades) →
`INSUFFICIENT_SAMPLE`, whatever the rate. Otherwise: a win rate is judged by
its Wilson interval and an exact binomial tail; an expectancy by its normal
interval and a one-sided z-test on the per-Trade spread (valid at `n ≥ 30`,
which the floor guarantees). Raw verdict `SUPPORTED` when the one-sided
p-value is below `alpha`, else `NOT_SUPPORTED`. `GATE_POLICY_VERSION` 1.

### D6 — A family is corrected together

Every hypothesis belongs to a family — the set of claims tested together. A
family's verdict applies Holm's step-down correction across every tested
member: a hypothesis is `SUPPORTED` only if it survives it, and the family
size `m` is shown with it. Ten claims at 5% each is not 5%.

### D7 — A finding cannot be said without its context

A `Finding` carries everything spec §5.2 and PLAN §12 name — hypothesis id,
sample size, date range, instrument count, regime, costs, slippage, cost,
slippage, exit, sizing and detector versions, out-of-sample status, interval,
p-value, raw and family-corrected verdict. The one function that renders a
finding as text refuses one that lacks any of them. `78% win rate` without
`n = …` cannot be produced.

### D8 — Research database only

Registration and tests read `candles` and write `strategy_experiments`;
nothing else, and nothing in the trading database.

---

## 4. Proposed task order

| ID  | Task                                                                                          | Depends on    |
| --- | --------------------------------------------------------------------------------------------- | ------------- |
| 7.1 | Statistics primitives, pinned to reference values (D1)                                        | —             |
| 7.2 | A matrix cell carries its dispersion; counterfactual version 2 (D2)                           | —             |
| 7.3 | The hypothesis: schema, rules, fingerprint, registry (D3)                                     | —             |
| 7.4 | The gate: one out-of-sample test — minimum sample, interval, p-value, version check (D4, D5)  | 7.1, 7.2, 7.3 |
| 7.5 | Families: Holm correction; a finding that cannot be said without its context (D6, D7)         | 7.4           |
| 7.6 | Kept in `strategy_experiments`, research database only; operator CLI (D8)                     | 7.5           |
| 7.7 | Acceptance: a family registered on the first half of the real year, tested once on the second | 7.6           |

---

## 5. Done when

A family of hypotheses formed on the first half of the stored year, registered
before any test, is tested once each on the second half; each verdict carries
its sample size, interval, p-value, costs, slippage, regime, versions and
out-of-sample status; small samples are refused rather than judged; the
family's correction is applied and shown; and a second test of the same
hypothesis is refused.

---

## Related documents

- [../PLAN.md](../PLAN.md) §12
- [../architecture/RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md) Phase 7, §5.2, §8
- [PHASE_6_COUNTERFACTUAL_EVALUATION.md](PHASE_6_COUNTERFACTUAL_EVALUATION.md) — the matrix and its limits C1–C7
