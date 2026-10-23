# Phase 12 — Automated strategy hypothesis

**Status: see [PLAN.md](../PLAN.md) §17.** Phase 12 is open; its task board
lives there and nowhere else. This document holds the decisions the board's
tasks implement.

Authorities: [PLAN.md](../PLAN.md) §17 for scope,
[RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md)
Phase 12, §5.2 (the statistical gate: "a strategy candidate cannot be created
from an unregistered hypothesis"), §8.3 (AI may propose, not decide) and §5.4
(lookahead); [ARCHITECTURE_DECISION.md](../architecture/ARCHITECTURE_DECISION.md)
§5.4 and §12 ("AI may create a candidate. AI may never bypass validation or
approval").

---

## 1. Goal

> AI may propose `Hypothesis → Registry → Validation`. A proposal is not
> automatically a strategy.

The research agent of Phase 11 proposes hypotheses — claims about how a
strategy behaves on a cell, or about a parameter variant of one — from the
evidence it read; the operator registers the ones they accept, before any
out-of-sample data is looked at; Phase 7's gate tests each once, out of
sample, corrected within its family. Nothing here creates, changes or enables a
strategy.

---

## 2. What exists

### 2.1 The parts are built

- **The registry and the gate** (Phase 7): `HypothesisSchema` — a cell
  (pattern × strategy × symbol × regime), a metric (`winRate`, `expectancy`,
  `expectancyPerUnit`), a direction and threshold, `alpha`, `minSample` ≥ 30,
  in-sample and out-of-sample windows, the run (including `strategyParams`, a
  parameter variant) and the pins read off an in-sample counterfactual run;
  registration once per claim (a fingerprint refuses a duplicate);
  `testRegistered` once per hypothesis; Holm within a family, untested members
  counted.
- **The agent** (Phase 11): six read-only tools bound to an `asOf`, the answer
  checker, `agent_answers`, the CLI.
- **The strategies' own parameter schemas** (`paramsSchema` on each
  definition): a variant is validated by the strategy it varies.

### 2.2 A gap that Phase 12 makes acute

`testRegistered` does not check that the out-of-sample window has closed. A
hypothesis proposed as of today has its window in the future; tested early it
spends its single test on missing data and is recorded INSUFFICIENT_SAMPLE —
and can never be tested again. Closed here (D6).

### 2.3 The decisions taken at opening

**Q1 — the operator approves registration**, by the operator. The agent's
proposals are checked and kept; nothing is registered until the operator
registers them from the kept answer.

**Q2 — cells and parameter variants**, by the operator. A proposal is a claim
about an existing strategy on a cell, as configured or with different
parameters. New strategy logic — an added filter, a new rule — is Phase 13's.

---

## 3. Design decisions

### D1 — A proposal is part of an answer

The agent's terminal tool, `submit_answer`, gains optional **proposals**: each a
statement, a cell, a metric, a direction and a threshold, optionally a
parameter variant of the cell's strategy, and a rationale — claims citing the
session's tool calls, checked exactly as an answer's claims are (Phase 11 D3).
At most five per answer. The model chooses none of: the windows, `alpha`,
`minSample`, the run. An answer's proposals are kept with it in
`agent_answers`.

### D2 — What the agent saw is the in-sample window

A proposal made as of `asOf` was formed on what the tools could show: every
session up to `asOf`. That is its in-sample window — from the first researched
session to `asOf` — fixed by code. The out-of-sample window is the operator's,
given at registration, and **must start after `asOf`**: a proposal can never be
tested on data its author could read (§5.4). When the proposal is made as of a
past date on stored data, the out-of-sample data exists but the tools could not
reach it; the record says so.

### D3 — A proposal is checked before it can be registered

Deterministic, at submission: the rationale passes the answer checker; the
cell names a pattern the detector catalog knows (or `ALL`, the baseline), a
strategy the counterfactual can replay, a symbol the run covers, a regime; a
parameter variant parses under that strategy's `paramsSchema` and differs from
its defaults; a win-rate threshold lies in 0–1. A proposal that fails is kept
with its reasons and can never be registered.

### D4 — The operator registers; the AI cannot

`agent.mts register <answerId> --out-of-sample=FROM:TO [--pick=1,3]`
registers the valid proposals of a **SUPPORTED** answer — all, or those
picked — as hypotheses: one family per answer (`P-<answerId>`), so the family's
correction counts every proposal registered from it; `alpha` 0.05 and
`minSample` 30 by policy; the in-sample window of D2; pins from an in-sample
counterfactual run under the proposal's parameters; and a link to the answer
and proposal it came from. Registration refuses an out-of-sample window that
does not start after `asOf`, and a claim already registered. Picking happens
before any out-of-sample result exists, so it cannot select on outcomes.

### D5 — Nothing becomes a strategy

No step here creates a strategy, changes a strategy's configuration, or marks
anything as a candidate for paper or live trading. A SUPPORTED finding about a
variant is evidence that a candidate is worth building; building and
validating it is Phase 13.

### D6 — A test waits for its window to close

`testRegistered` refuses — keeping nothing — while the out-of-sample window
ends after the last stored session of the run's instruments. The test happens
once, when the evidence exists.

---

## 4. Open decisions

| #   | Question                                                | Decided                                                                              |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Q1  | Register automatically, or after the operator approves? | **The operator approves**, by the operator at opening.                               |
| Q2  | What may be proposed?                                   | **Cells and parameter variants**, by the operator at opening; new logic is Phase 13. |

---

## 5. Proposed task order

| ID   | Task                                                                                                                                                            | Depends on |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 12.1 | The proposal contract: proposals in an answer, checked — cell, metric, variant against the strategy's own schema, rationale through the answer checker (D1, D3) | —          |
| 12.2 | Proposal sessions: the agent asked to propose, its proposals kept and rendered with their checks (D1)                                                           | 12.1       |
| 12.3 | A test waits for its window to close (D6)                                                                                                                       | —          |
| 12.4 | Registration by the operator: in-sample fixed to what the agent saw, out-of-sample after it, one family per answer (D2, D4, D5)                                 | 12.2, 12.3 |
| 12.5 | Acceptance: proposals as of a past date on the real year, registered, tested out of sample, corrected; a future window refused; an invalid variant refused      | 12.4       |

---

## 6. Done when

The agent, asked as of a date, proposes hypotheses — cells or parameter
variants — each resting on checked evidence; the operator registers the ones
they accept, the in-sample window being exactly what the agent could see and
the out-of-sample window after it; each is tested once, out of sample, only
when its window has closed, and corrected within its family; and nothing in
the path creates or changes a strategy.

---

## 7. Acceptance (task 12.5)

The year researched on a scratch copy as before (494 daily reports, 71
windows, the year's counterfactual, 4,949 documents); the agent — Gemini,
`gemini-3.5-flash-lite` — asked to propose **as of 2026-03-27**, so it could
see the first half of the year and nothing after; the proposals registered and
tested on the second half, **2026-03-30 .. 2026-09-28**. The registration step
is the operator's (Q1); for the acceptance it was taken on the scratch copy
only — nothing was registered in the research database. At `e19b6bf`.

| Hypothesis | Proposed (as of 2026-03-27)                                              | In sample                | Out of sample               | Verdict, Holm within its family                           |
| ---------- | ------------------------------------------------------------------------ | ------------------------ | --------------------------- | --------------------------------------------------------- |
| H-0003     | RSI's win rate on RSI_REVERSION is under 20%                             | n = 284, 15.8%           | n = 277, 14.8% (11.6–18.7%) | **SUPPORTED**, p 0.0159, adjusted 0.0319 in a family of 3 |
| H-0004     | ORB loses money after ORB_BREAKOUT                                       | n = 319, −141.04 a Trade | n = 319, −154.90 a Trade    | **SUPPORTED**, adjusted 4.45e-26                          |
| H-0005     | EMA_CROSSOVER loses money after ORB_BREAKOUT                             | n = 28                   | n = 27                      | INSUFFICIENT_SAMPLE — not judged (< 30)                   |
| H-0006     | EMA_CROSSOVER with fast 20, slow 50 (a variant) loses money on EMA_CROSS | n = 12                   | n = 7                       | INSUFFICIENT_SAMPLE — the slower variant barely trades    |

- **The windows held:** each registered in sample from the first researched
  session to 2026-03-27, out of sample from 2026-03-30; a window starting on
  2026-03-27 was refused.
- **The variant was pinned as itself:** `strategyParams` `{ EMA_CROSSOVER:
{ fast: 20, slow: 50 } }`, its own strategy version (`cfg-189ffb…`), its own
  in-sample run.
- **A future window waits:** proposed as of 2026-09-28 and registered with
  2026-10-01 .. 2026-12-31, H-0007's test was refused — nothing kept — until the
  data covers it; it stays UNTESTED.
- **An answer that passed an earlier, weaker check cannot be registered:** the
  answer whose variants named `fast_ema`/`slow_ema` (F2) no longer audits, and
  registration refuses it.
- **Nothing became a strategy:** `strategies` unchanged; only
  `strategy_experiments` (hypotheses and tests) and `agent_answers` written.
- `pnpm test:integration`, strict: 1,547 tests across 13 packages, 0 skipped, 0 failed.

**Found by the acceptance, and fixed:**

| #   | Finding                                                                                                                                                                                                       | Fix                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Asked for parameter variants, the model declined: "no records exist for the requested variants" — the absence of a variant's record read as the absence of evidence.                                          | The prompt says a variant rests on the evidence about the strategy as configured, and that testing it is what registration is for (`e9f09ba`).                                   |
| F2  | Variants named `fast_ema`/`slow_ema` were checked "registrable": a strategy's schema drops keys it does not know and fills defaults, so the default strategy would have been tested under the variant's name. | Every proposed parameter must come out of the strategy's own schema exactly as given (`7ce9a9b`).                                                                                |
| F3  | A rationale cited 294 Trades for EMA_CROSSOVER on ORB_BREAKOUT; the registered cell counted 28. `strategyMatrix` (Phase 10) counted a Trade once for every occurrence it was held open through.               | The matrix counts the Trades entered on the pattern, each once — as the counterfactual matrix and every hypothesis cell do (`e19b6bf`); on the real year they now agree exactly. |

F3 corrects figures quoted from the matrix in Phase 11 §7, including its F4 —
see the note there.

**Still standing:**

| #   | Limit                                                                                                                                                                                                         | Owner                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| P1  | A proposal's rationale is checked for presence, not meaning (Phase 11 F4): H-0005's rationale quoted the inflated matrix count; the claim itself was sound and its test used the right one.                   | by design              |
| P2  | Proposals made as of a past date were tested on stored data the tools could not reach — a pseudo-prospective test. A truly prospective one is a proposal as of today, tested when its window closes (H-0007). | by design              |
| P3  | New strategy logic — a filter, a rule — cannot be proposed; only cells and parameter variants (Q2).                                                                                                           | Phase 13               |
| P4  | The research database holds no research yet (Phase 10 K1): nothing can be proposed from it until the research runs there.                                                                                     | operations             |
| P5  | Free-tier Flash-Lite needed several corrections per proposal session; small samples (H-0005, H-0006) are honestly not judged.                                                                                 | operator, model choice |

## Related documents

- [../PLAN.md](../PLAN.md) §17
- [PHASE_7_STATISTICAL_VALIDATION.md](PHASE_7_STATISTICAL_VALIDATION.md) — the registry and the gate
- [PHASE_11_AI_RESEARCH_AGENT.md](PHASE_11_AI_RESEARCH_AGENT.md) — the agent that proposes
