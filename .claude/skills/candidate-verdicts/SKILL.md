---
name: candidate-verdicts
description: List the declared strategy candidates with their latest verdict, or show one candidate's walk-forward and the validation gate's criteria, using the validation CLI's own numbers. Use when the operator asks which candidates passed, or why one failed. Reads only.
---

# Candidates and verdicts

Runs `apps/api/scripts/validation.mts` (Phase 13) with one of its two reads,
`list` or `verdict`, against the research database, and explains the
printout. The numbers are the CLI's, quoted verbatim. The conventions are in
`.claude/skills/README.md`.

## When to use

- "Which candidates are there, and which passed?" Use `list`.
- "Why did SC-0002 fail?" Use `verdict`; each criterion shows ✓ or ✗ with
  its threshold and value.
- "What did an earlier walk-forward of SC-0001 say?" Use `verdict` with
  `--walk-forward`.

Not for these, which are the operator's acts and stay so:

- Declaring a candidate.
- Running a backtest or a walk-forward. A walk-forward is kept, and a new
  one changes what `verdict` judges by default.
- What a strategy did over given dates. That is the `replay` skill.

## Command

From the repository root. It runs the built code, so if `apps/api/dist` may be
stale, ask the operator to run `pnpm build` first.

```sh
cd apps/api && node --env-file=../../.env.local scripts/validation.mts list --db=neelkanth_research
cd apps/api && node --env-file=../../.env.local scripts/validation.mts verdict --candidate=<candidate> --db=neelkanth_research
cd apps/api && node --env-file=../../.env.local scripts/validation.mts verdict --candidate=<candidate> --walk-forward=<walk-forward> --db=neelkanth_research
```

Run one of them. `--db=neelkanth_research` is always given.

## Inputs

| Flag             | Meaning                                                         | Default                |
| ---------------- | --------------------------------------------------------------- | ---------------------- |
| `--candidate`    | A candidate id as `list` prints it, e.g. `SC-0001`              | required for `verdict` |
| `--walk-forward` | A walk-forward id of that candidate, e.g. `wf_…`                | the candidate's latest |
| `--dns`          | Resolvers for a `mongodb+srv` lookup the local resolver refuses | system                 |

## Output

`list` prints one line per candidate:

```text
SC-0001  ORB             3 variants  H-0003  PASS  <the candidate's statement>
SC-0002  RSI             2 variants  H-0004  not walked forward  <statement>
```

The columns are: the candidate id; its strategy type; the number of parameter
variants in its grid; the hypothesis it was declared from; the verdict of its
**latest** walk-forward (`PASS`, `FAIL`, or `not walked forward`); and its
statement. No lines means no candidates are declared.

`verdict` prints the walk-forward, its out-of-sample result, and the gate:

```text
SC-0001 — wf_…, 6 folds
candidate  n =   41  net     5230.00  per Trade   127.56  p 0.0310  win 53.7%  PF 1.42  DD 4.1%  Sharpe 1.10  months+ 66.7%
fingerprint …

verdict      FAIL (gate 1) — failed: stressedExpectancy
  ✓ trades               ≥ 30                                             41
  ✗ stressedExpectancy   > 0 with slippage ×2 and charges ×1.5            -12.40 per Trade
```

The values in these samples are made up to show the format. Never quote them
as a result.

| Field               | Meaning                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| first line          | The candidate, the walk-forward judged, and its number of folds                      |
| `n`                 | Out-of-sample trades, across all test windows                                        |
| `net`, `per Trade`  | Out-of-sample net P&L in ₹, and expectancy per trade                                 |
| `p`                 | One-sided p-value that expectancy is above zero                                      |
| `win`, `PF`         | Win rate; profit factor. `—` means not defined, e.g. no trades                       |
| `DD`                | Maximum drawdown as a share of capital                                               |
| `Sharpe`, `months+` | Sharpe ratio of daily P&L, annualised; share of months that were profitable          |
| `fingerprint`       | The walk-forward's hash. The same inputs give the same fingerprint                   |
| `verdict`           | `PASS` only when every criterion holds; the gate version; the criteria that failed   |
| criteria lines      | ✓ held or ✗ not, the criterion's name, its threshold, and the value it was judged on |

The gate's six criteria (gate version 1) are `trades`, `expectancy`,
`profitFactor`, `maxDrawdown`, `stressedExpectancy` and `againstBaseline`.
Read each one's threshold from the printout rather than from here.

A refusal is one line, `refused: …`. Report it as printed and stop:

- `refused: refusing "<name>": only neelkanth_research or a scratch …` means
  the database was refused.
- `refused: no walk-forward of <candidate>` means it was never walked forward,
  or the `--walk-forward` id is not one of its.
- `refused: --candidate=<value> is required` means ask the operator which
  candidate.

## Must not claim

- That `PASS` approves anything. `PASS` makes a candidate eligible for paper
  validation (Phase 14), no more. It enables, changes and promotes nothing.
- That a candidate will make money in paper or Live. The figures are
  out-of-sample over stored candles, at modelled slippage and charges.
- That a `FAIL` on one criterion is "nearly a pass", or that changing a
  parameter would pass. Either is a new walk-forward, the operator's act.
- A verdict for a walk-forward other than the one the first line names.

## Never

<!-- never-list:start -->

- Place, modify or cancel an order, or square off a position.
- Kill, pause or resume trading.
- Change a risk limit, a setting or a strategy, or provision one.
- Take an act a CLI reserves for the operator, such as declaring a candidate.
- Open, print or quote a `.env*` file, a token or a key.
- Call the control-plane API, or connect to MongoDB or Redis directly.
- Run against a Live trading database, or a paper one except through
  `paper-report`'s two reads; or retry a refused command with different
  arguments to get past the refusal.

<!-- never-list:end -->
