---
name: paper-report
description: Show a paper trading session's report — its signals, orders, trades, P&L, reconciliation, restarts, and parity against its own replay — or the list of kept session reports, using the paper CLI's own numbers. Use when the operator asks how a paper session went. Reads only; keeps nothing.
---

# Paper session report

Runs `apps/api/scripts/paper.mts` (Phase 14) with one of its two reads,
against the paper database, and explains what it printed. The numbers are
the CLI's, quoted verbatim. The conventions are in `.claude/skills/README.md`.

This is the one skill that reaches a paper database (design §8 D6). It runs
`reports`, and `report` with `--dry-run` only, so it never keeps anything.

## When to use

- "How did today's paper session go?" Use `report` with no `--session`.
- "Was the 2026-10-28 session clean? Why not?" Use `report` with
  `--session`. The ✓/✗ lines and the parity differences say why.
- "Which paper sessions have been reported, and were they clean?" Use
  `reports`.

Not for these, which are the operator's acts and stay so:

- Provisioning the test subject (`provision`). It writes strategies.
- Keeping a session's report (`report` without `--dry-run`). That is how a
  session enters the record that `reports` lists.

Not for these either:

- What a strategy would have done over other dates. That is the `replay`
  skill.
- Live trading. This skill never reaches a Live database.

## Command

From the repository root. It runs the built code, so if `apps/api/dist` may be
stale, ask the operator to run `pnpm build` first.

```sh
cd apps/api && node --env-file=../../.env.paper scripts/paper.mts report --db=neelkanth_paper --dry-run
cd apps/api && node --env-file=../../.env.paper scripts/paper.mts report --session=<session> --db=neelkanth_paper --dry-run
cd apps/api && node --env-file=../../.env.paper scripts/paper.mts reports --db=neelkanth_paper
```

Run one of them. `--db=neelkanth_paper` is always given, and `report` always
takes `--dry-run`.

## Inputs

| Flag        | Meaning                                                                         | Default     |
| ----------- | ------------------------------------------------------------------------------- | ----------- |
| `--session` | An IST trading date, `YYYY-MM-DD`, for `report`                                 | today (IST) |
| `--limit`   | How many sessions `reports` lists, newest first                                 | `10`        |
| `--dns`     | Resolvers for a `mongodb+srv` lookup the local resolver refuses, e.g. `1.1.1.1` | system      |

## Output

`report` prints one session:

```text
session      2026-10-28   NOT CLEAN
replay       5m bars from 2026-10-21, 450 bars, str_orb@1, str_ema@1
bars         3f9a…

signals      2
  09:35:00  str_orb                NSE:NIFTY50-INDEX    BUY  @ 24510.00  approved  opening range break

orders       2
  09:35:01  NSE:NIFTY50-INDEX    BUY      50 FILLED    fill 24512.40  decision 24510.00  slippage 2.40  charges 41.20

trades       1
  str_orb                NSE:NIFTY50-INDEX    LONG     50  09:35:01 24512.40 → 10:20:00 24560.00  TAKE_PROFIT     net 2297.60

P&L          gross 2380.00  charges 82.40  net 2297.60  (1 closed, 0 open)

✗ reconciliation  BOOT 09:10:00 clean  — missing CLOSE
  restarts       none
✓ flat at the close
✓ parity (v1, ±10/50 bps, 1 bar)  paper 2 signals / 1 trades, replay 2 / 1

kept         no (dry run)
```

The values in these samples are made up to show the format. Never quote them
as a result.

| Field               | Meaning                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`           | The date, then `CLEAN` only when reconciliation is clean, the day closed flat, and parity is clean                                                               |
| `replay`, `bars`    | The replay the session is held against: its interval, warm-up start, bar count, strategies and versions; and the bars' fingerprint                               |
| `signals`           | Each signal: IST time, strategy, symbol, side, decision price, the risk decision (`approved`, or `blocked` with the check that held), and the strategy's reason  |
| `orders`            | Each order: fill time, symbol, side, quantity, status, fill and decision prices, slippage against the decision, charges, exit reason, any refusal                |
| `trades`            | Each trade: strategy, symbol, side, quantity, entry and exit (IST time and price), exit reason or status, and net P&L                                            |
| `P&L`               | Gross, charges and net in ₹ over closed trades; how many closed and open                                                                                         |
| `reconciliation`    | ✓ when every run was clean, a `CLOSE` run happened, and no risk event was raised. Each run: `BOOT` or `CLOSE`, IST time, clean or its mismatch count             |
| `restarts`          | IST times the process booted again during the session                                                                                                            |
| `flat at the close` | ✓ when no trade was left open                                                                                                                                    |
| `parity`            | ✓ when the session and its own replay agree within the tolerances shown; then the signals and trades each side had                                               |
| difference lines    | Below parity, one per disagreement: its kind (`SIGNAL`, `RISK`, `TRADE`, `STRATEGY_VERSION`, `REPLAY`), what was compared, the field, paper's value and replay's |
| `kept`              | `no (dry run)`                                                                                                                                                   |

`reports` prints one line per session, newest first, from the reports the
operator has kept:

```text
2026-10-28  NOT CLEAN    1 trades  net    2297.60    0 differences  restarts 0  reconciliation NOT clean  psr_2026-10-28_…
```

The columns are: the session; `CLEAN` or `NOT CLEAN`; closed trades; net P&L
in ₹; parity differences; restarts; reconciliation; the report's id. It shows
the latest kept report of each session. A session nobody kept a report for is
not listed, and no lines means none has been kept.

A refusal is one line, `refused: …`. Report it as printed and stop:

- `refused: paper mode runs only on a paper database … not "<name>"` means
  the database was refused.
- `MONGO_URI is not set` means `.env.paper` holds no `MONGO_URI`. Say so; do
  not open the file.

## Must not claim

- That a `CLEAN` session, or any number of them, approves a strategy for Live.
  Promotion is Phase 15, and the operator's.
- That paper P&L is what Live would have made. Paper fills are simulated,
  never FYERS's: no real order book, no queue position.
- That a report for today is final while the session is open. Before the bell
  it is partial, and `missing CLOSE` is expected.
- That a session is clean or not clean when `reports` does not list it. It
  was never kept; run `report` for it instead.
- That a parity difference is a bug, or that it is harmless. State it as
  printed.

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
