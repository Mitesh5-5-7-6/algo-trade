---
name: setup-odds
description: Work out the odds of one trade plan — entry, stop, target, at a date and time — reaching its target before its stop, by replaying the rest of the day from past sessions and by running the plan's rule over real history, using the setup-odds CLI's own numbers (the "Time Machine"). Use when the operator asks what the odds of a plan are, whether a setup is a coin flip, or how often a rule has reached its target. Keeps nothing (dry run).
---

# Setup odds — the "Time Machine"

Runs `apps/api/scripts/odds.mts` (Phase 17, task 17.6) once, against the
research database, and explains its printout. The numbers are the CLI's, quoted
verbatim. The conventions are in `.claude/skills/README.md`.

## When to use

- "What are the odds this BANK NIFTY long reaches 55,600 before 55,300?"
- "Is this setup better than a coin flip?" The `resampled odds` line holds the
  target's share against break-even.
- "How often has ORB reached its target on NIFTY?" Give `--rule-type`; the
  `history` lines answer.

Not for these:

- What a strategy did over past dates, trade by trade. That is the `replay`
  skill.
- Whether a strategy may be promoted. That is a walk-forward and the
  validation gate (the `candidate-verdicts` skill).
- An option's premium, its odds or its P&L. The odds are the underlying's.
- A plan for a stock or a date the research database holds no bars for.

## Command

From the repository root. It runs the built code, so if `apps/api/dist` may be
stale, ask the operator to run `pnpm build` first.

```sh
cd apps/api && node --env-file=../../.env.local scripts/odds.mts --symbol=<symbol> --side=<side> --entry=<entry> --stop=<stop> --target=<target> --date=<date> --time=<time> --rule-type=<rule-type> --index-symbols=<index-symbols> --db=neelkanth_research --dry-run
```

`--db=neelkanth_research` and `--dry-run` are always given. Leave out
`--rule-type` and `--index-symbols` when the operator names no rule: the
history is then not run, and the `history` line says so. Add `--rule-params`,
`--replays`, `--seed`, `--window`, `--pool-sessions`, `--capital` or `--dns`
only when asked.

## Inputs

| Flag              | Meaning                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--symbol`        | The underlying whose bars are used, e.g. `NSE:NIFTYBANK-INDEX`. For an option plan, its index                               |
| `--side`          | `LONG` or `SHORT`                                                                                                           |
| `--entry`         | The entry price, in the underlying's points                                                                                 |
| `--stop`          | The stop: below the entry for a long, above it for a short                                                                  |
| `--target`        | The target: above the entry for a long, below it for a short                                                                |
| `--date`          | The plan's IST date, `YYYY-MM-DD`. Only sessions strictly before it are read                                                |
| `--time`          | The IST time the entry was decided, `HH:MM`, from `09:20` to `15:25`                                                        |
| `--rule-type`     | The plan's rule as a strategy type — `ORB`, `EMA_CROSSOVER` or `RSI` (`packages/strategies`) — for the history method       |
| `--rule-params`   | That rule's parameters as JSON in single quotes, e.g. `'{"rangeMinutes":15}'`. Default: the rule's own defaults             |
| `--index-symbols` | Indices the rule's replay reads for its market view, loaded beside `--symbol`, e.g. `NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX` |
| `--replays`       | How many times the rest of the day is replayed. Default 10000                                                               |
| `--seed`          | The resampling's seed. Default 0. Same arguments and seed give the same fingerprint                                         |
| `--window`        | How many bars either side of its own time of day a drawn bar may come from. Default 1                                       |
| `--pool-sessions` | Use only the most recent this-many full sessions before `--date`, for both methods. Default: every one held                 |
| `--capital`       | Allocated capital in ₹ for the rule's replay. Default 1000000. It sizes the replay's trades; R does not depend on it        |
| `--dns`           | Resolvers for a `mongodb+srv` lookup the local resolver refuses, e.g. `1.1.1.1`                                             |

Candles are 5-minute, and the rule's replay uses the default global limits.

## Output

```text
database       neelkanth_research
plan           LONG NSE:NIFTYBANK-INDEX entry 55400 stop 55300 target 55600 (2.00R), 2026-11-16 10:05, after bar 9
basis          the underlying's own bars — not an option's premium; R is gross, in index points, with no charges or slippage
pool           276 full sessions (2025-09-29 .. 2026-11-13), 75 bars each, {"BROKER_HISTORICAL":20700}
left out       2026-02-01 SPECIAL_SESSION (75 bars)
resampled      10000 replays, seed 0, window ±1: target first 3100 (31.0%), stop first 6200 (62.0%), neither 700 (7.0%)
resampled odds of 9300 decided: target 33.3% against break-even 33.3% (+0.0 points) — NEAR_BREAK_EVEN
resampled R    average 0.004R; 9 stops came through a gap, each scored −1R, which understates the real fill
close bands    p5 54900.00, p25 55200.00, p50 55400.00, p75 55650.00, p95 56000.00
history        ORB cfg-… over 279 sessions: fired 180 LONG (other side 169) — target 48, stop 82, neither 50
history odds   of 130 decided: target 36.9% (95% interval 29.1% .. 45.5%) against the rule's own break-even 38.3% (-1.3 points)
history R      average 0.053R over all 180 times it fired (95% interval -0.110R .. 0.216R) — INCONCLUSIVE
limits         each resampled bar is drawn on its own, so a replayed day has no momentum or volatility clustering; expiry days are not separated; replays are not independent observations
fingerprint    9ad3…
kept           nothing (dry run)
```

| Field            | Meaning                                                                                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `database`       | The database read. Always `neelkanth_research` here                                                                                                                                                                                                                                                          |
| `plan`           | The plan as given, the target's distance in units of the stop's (`R`), and the last bar that had closed by `--time`, counted from the 09:15 bar as 0                                                                                                                                                         |
| `basis`          | What every number below is measured on. Say it first: the underlying, not an option; gross R, no costs                                                                                                                                                                                                       |
| `pool`           | The full regular sessions used: how many, the first and last date, bars per session, and the bars by candle source                                                                                                                                                                                           |
| `left out`       | Sessions before `--date` that were not used — `SPECIAL_SESSION` (a weekend or declared special session) or `INCOMPLETE` (not exactly the regular bars) — or `none`                                                                                                                                           |
| `resampled`      | The replays: how many reached the target first, the stop first, or neither by the close. A bar touching both counts as the stop                                                                                                                                                                              |
| `resampled odds` | Of the replays that reached either level, the target's share; the break-even share `1 / (1 + R)`; the gap in percentage points; and the verdict — `FAVOURABLE_STRONG` (15 points or more over), `FAVOURABLE` (5 or more), `NEAR_BREAK_EVEN`, `UNFAVOURABLE`, `UNFAVOURABLE_STRONG`, or `NO_DECIDED_OUTCOMES` |
| `resampled R`    | The average R per replay (a win pays R, a stop −1, an undecided replay where it closed), and how many stops came through a gap                                                                                                                                                                               |
| `close bands`    | Percentiles of where the replayed day closed, in the underlying's points                                                                                                                                                                                                                                     |
| `history`        | The rule and its strategy version, the sessions it was replayed over, how often it traded the plan's side and the other, and how those trades ended. Or `not run — the plan names no rule`                                                                                                                   |
| `history odds`   | Only with a rule: of the rule's trades that reached target or stop, the target's share, its 95% interval, and the break-even of the rule's own targets                                                                                                                                                       |
| `history R`      | Only with a rule: the average R of every time the rule fired, its 95% interval, and the verdict — `FAVOURABLE` or `UNFAVOURABLE` once that interval clears zero, `INCONCLUSIVE` while it holds zero, `INSUFFICIENT_SAMPLE` below 30 trades                                                                   |
| `limits`         | What the method cannot show. Repeat it with any answer                                                                                                                                                                                                                                                       |
| `fingerprint`    | The hash of the inputs and results. Equal fingerprints are the same run                                                                                                                                                                                                                                      |
| `kept`           | `nothing (dry run)`                                                                                                                                                                                                                                                                                          |

The values in the sample above are made up to show the format. Never quote
them as a result.

A refusal ends the run with an `Error:` line and a stack. Report its first
line only:

- `refusing "<name>": setup odds reads and writes only neelkanth_research or a scratch …`
  means the database was refused. Report it and stop.
- `no full session of <symbol> before <date>: nothing to draw from` means the
  research database holds no complete session of that symbol before the date.
  Say so.
- `a long's stop must be below its entry`, and the like, mean the plan's levels
  are on the wrong side. Ask the operator.
- `<time> is before the first bar of the session has closed`, or
  `… nothing left to replay`, means `--time` is outside `09:20` to `15:25`.
- `--<flag>=<value> is required` means an input is missing. Ask the operator
  for it.
- `MONGO_URI is not set` means `.env.local` holds no `MONGO_URI`. Say so; do
  not open the file.

## Must not claim

- That the odds are an option's. They are the underlying's odds of reaching
  the levels; an option's premium also moves with time and volatility.
- That R is money. It is gross, in index points, before any charge or
  slippage.
- That the resampled odds are a forecast, or come from 10,000 observations.
  They are redraws from the sessions in `pool`, each bar drawn on its own.
- That the two methods agree or disagree "on average". Report each beside
  the other, with its sample; never combine them into one number.
- That a `FAVOURABLE` verdict means the trade should be taken, or that an
  `INCONCLUSIVE` or `INSUFFICIENT_SAMPLE` history says the rule does not work.
  State the number of trades and the interval.
- That the plan would have been filled at its entry, or anything about
  position size or risk limits.

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
