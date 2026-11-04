---
name: replay
description: Replay one strategy over stored research candles and explain what it did — signals, risk decisions, trades, realized P&L — using the replay CLI's own numbers. Use when the operator asks what a strategy would have done over past dates. Keeps nothing (dry run).
---

# Replay

Runs `apps/api/scripts/replay.mts` (Phase 4, task 4.8) once, against the
research database, and explains its printout. The numbers are the CLI's, quoted
verbatim. The conventions are in `.claude/skills/README.md`.

## When to use

- "What would ORB have done on NIFTY last week?"
- "Why did EMA_CROSSOVER not trade between these dates?" The `risk` line says
  which gate held.
- "Does the same replay give the same result?" Compare the `fingerprint`
  lines.

Not for these:

- Whether a strategy is good enough to promote. That is a walk-forward and the
  validation gate (the `candidate-verdicts` skill).
- What happened in a paper session. That is the paper report.
- Live performance. Replay never sees a broker.

## Command

From the repository root. It runs the built code, so if `apps/api/dist` may be
stale, ask the operator to run `pnpm build` first.

```sh
cd apps/api && node --env-file=../../.env.local scripts/replay.mts --strategy-type=<type> --params=<params> --symbols=<symbols> --index-symbols=<index-symbols> --from=<from> --to=<to> --capital=<capital> --db=neelkanth_research --dry-run
```

`--db=neelkanth_research` and `--dry-run` are always given. Leave out
`--params` and `--index-symbols` when the operator gives none. Add `--seed`,
`--exit-rules` or `--dns` only when asked.

## Inputs

| Flag              | Meaning                                                                                                                                                                                              | Default            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `--strategy-type` | One of `ORB`, `EMA_CROSSOVER`, `RSI`, `INDEX_OPTION_MOMENTUM`, `INDEX_OPTION_FLOW_BREAKOUT`, `INDEX_OPTION_PCR_OI`, `INDEX_OPTION_SENTIMENT_FADE`, `OPTION_MOMENTUM_SCALPER` (`packages/strategies`) | required           |
| `--params`        | The strategy's parameters as JSON in single quotes, e.g. `'{"quantity":1}'`                                                                                                                          | `{}`               |
| `--symbols`       | Comma-separated FYERS symbols to trade, e.g. `NSE:NIFTY50-INDEX`                                                                                                                                     | required           |
| `--index-symbols` | Extra symbols the strategy reads for bias, loaded beside `--symbols`                                                                                                                                 | none               |
| `--from`, `--to`  | IST trading dates, `YYYY-MM-DD`, inclusive                                                                                                                                                           | required           |
| `--capital`       | Allocated capital in ₹, for sizing                                                                                                                                                                   | required           |
| `--seed`          | The simulation's seed. Same arguments and seed give the same fingerprint                                                                                                                             | `0`                |
| `--exit-rules`    | Exit rules as JSON, e.g. `'{"maxHoldMinutes":60}'`                                                                                                                                                   | the strategy's own |
| `--dns`           | Resolvers for a `mongodb+srv` lookup the local resolver refuses, e.g. `1.1.1.1`                                                                                                                      | system             |

Candles are 5-minute, and risk uses the default global limits.

## Output

```text
database     neelkanth_research
strategy     ORB 1
dataset      NSE:NIFTY50-INDEX 5m
days         5 (2026-03-02 .. 2026-03-06), 375 bars, {"BROKER_HISTORICAL":375}
signals      4 {"BUY":3,"SELL":1}
risk         {"approved":3,"blocked:marketBias":1}  market view at end: BULLISH
trades       3 {"TAKE_PROFIT":1,"STOP_LOSS":2}
realized     -412.5  (open at end: 0)
fingerprint  9c1e…
kept         nothing (dry run)
```

| Field         | Meaning                                                                                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database`    | The database read. Always `neelkanth_research` here                                                                                                                                                                   |
| `strategy`    | The type and its strategy version                                                                                                                                                                                     |
| `dataset`     | The symbols and interval loaded                                                                                                                                                                                       |
| `days`        | The trading days found, the first and last, the bars, and the bars by candle source (`BROKER_HISTORICAL`, `LIVE_TICK`, `IMPORTED_DATA`). Fewer days than asked means candles are missing — say so                     |
| `synthetic`   | Only for option strategies: P&L is in index points on a synthetic contract, **not** a tradable option's premium                                                                                                       |
| `signals`     | Signals the strategy proposed, by side                                                                                                                                                                                |
| `risk`        | Risk decisions: `approved`, or `blocked:<check>` naming the check that held — `session`, `duplicate`, `marketBias`, `dailyLoss` or `positionSize`. Then the market bias at the end: `BULLISH`, `BEARISH` or `NEUTRAL` |
| `trades`      | Completed trades, by exit reason                                                                                                                                                                                      |
| `realized`    | Realized P&L in ₹ (index points when `synthetic` is shown), net of the replay's charges model, and the positions still open at the end, which are not in it                                                           |
| `fingerprint` | The hash of the inputs and code. Equal fingerprints are the same replay                                                                                                                                               |
| `kept`        | `nothing (dry run)`                                                                                                                                                                                                   |

The values in the sample above are made up to show the format. Never quote
them as a result.

A refusal ends the run with an `Error:` line and a stack. Report its first
line only:

- `refusing "<name>": replay reads and writes only neelkanth_research or a scratch …`
  means the database was refused. Report it and stop.
- `--<flag>=<value> is required` means an input is missing. Ask the operator
  for it.
- `MONGO_URI is not set` means `.env.local` holds no `MONGO_URI`. Say so; do
  not open the file.

## Must not claim

- That the realized P&L is what the strategy would have earned in paper or
  Live. Replay fills at a slippage model and charges at a charges model, both
  fixed by the fingerprint. Its fills and refusals are a simulator's, against
  no real order book — never FYERS's.
- For option strategies, anything in rupees of premium. `synthetic` P&L is in
  index points.
- That a replay over a few days says anything about the strategy in general.
  State the number of trades.
- That `open at end` positions were won or lost.

## Never

<!-- never-list:start -->

- Place, modify or cancel an order, or square off a position.
- Kill, pause or resume trading.
- Change a risk limit, a setting or a strategy, or provision one.
- Take an act a CLI reserves for the operator, such as declaring a candidate.
- Open, print or quote a `.env*` file, a token or a key.
- Call the control-plane API, or connect to MongoDB or Redis directly.
- Run against a paper or Live trading database, or retry a refused command
  with different arguments to get past the refusal.

<!-- never-list:end -->
