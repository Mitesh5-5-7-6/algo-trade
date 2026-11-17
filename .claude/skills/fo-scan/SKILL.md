---
name: fo-scan
description: Run the pre-open NSE F&O scan — every F&O underlying judged on its last daily bar before a trading day by the Phase 5 detectors (EMA cross, high-volume breakout, RSI reversion) — and explain which underlyings are candidates and why every other one was passed over, using the scan CLI's own numbers. Use when the operator asks what to look at today, which F&O stocks are breaking out, or to scan the market. Keeps nothing (dry run).
---

# F&O scan — the pre-open scanner

Runs `apps/api/scripts/scan.mts` (Phase 18, task 18.5) once, against the
research database, and explains its printout. The numbers are the CLI's, quoted
verbatim. The conventions are in `.claude/skills/README.md`.

## When to use

- "What should I look at today?" or "Scan the F&O stocks." Give today's date:
  the scan judges the last trading day before it.
- "Which F&O stocks broke out yesterday on volume?" The `candidates` lines name
  each one with the conditions that held and their evidence.
- "Why is RELIANCE not on the list?" Give `--all`; every underlying on which no
  condition held is listed with each condition's verdict.

Not for these:

- Whether to take a trade. A candidate is a structure that completed at the
  last close, not a signal: it has no entry, stop or size. The odds of a plan
  are the `setup-odds` skill.
- Intraday breakouts as they happen. The scan reads daily bars only.
- A day whose previous trading day has no daily bars stored. Fetching them is
  the backfill's job (`backfill-candles.mts --interval=1d`) and needs the
  broker's token, which this skill never handles.

## Command

From the repository root. It runs the built code, so if `apps/api/dist` may be
stale, ask the operator to run `pnpm build` first.

```sh
cd apps/api && node --env-file=../../.env.local scripts/scan.mts --date=<scan-date> --db=neelkanth_research --dry-run
```

`--db=neelkanth_research` and `--dry-run` are always given. Add `--all`,
`--min-days-to-expiry` or `--dns` only when asked.

## Inputs

| Flag                   | Meaning                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `--date`               | The IST trading day the scan is for, `YYYY-MM-DD`. Its conditions are judged on the last trading day before it                      |
| `--min-days-to-expiry` | A future expiring within this many days of the scan day is passed over for the next one. Default 2                                  |
| `--all`                | Also list every underlying on which no condition held, with each condition's verdict                                                |
| `--calendar`           | The trading calendar file. Default `scripts/calendars/nse-2025-26.json`                                                             |
| `--fo`, `--cm`         | Local copies of the broker's two symbol files, together. Default: fetched from `public.fyers.in` at scan time, which needs no token |
| `--dns`                | Resolvers for a `mongodb+srv` lookup the local resolver refuses, e.g. `1.1.1.1`                                                     |

## Output

```text
database       neelkanth_research
scan           2026-11-17, before the open — judged on the daily bars of 2026-11-16
universe       224 F&O underlyings, 0 left out; contracts expiring within 2 day(s) passed over
conditions     EMA_CROSS 1.0.0 — The fast EMA crosses from below to above the slow EMA …
               HIGH_VOLUME_BREAKOUT 1.0.0 — The close breaks the highest high …
               RSI_REVERSION 1.0.0 — RSI crosses back up through the oversold line …
status         PARTIAL
               the F&O ban list was not checked (design §7.1 D7): a candidate may be in the ban period
candidates     2
  ABCLTD       BULLISH  close   1234.50  NSE:ABCLTD26NOVFUT  lot 500  bar 2026-11-16
               HIGH_VOLUME_BREAKOUT BULLISH (close 1234.50, priorHigh 1220.00, priorLow 1150.00, volume 9000000, averageVolume 3000000)
  XYZ          BEARISH  close    456.70  NSE:XYZ26NOVFUT  lot 1200  bar 2026-11-16
               EMA_CROSS BEARISH (fast 460.10, slow 460.40, prevFast 461.00, prevSlow 460.90)
rejected       215 no condition held, 0 could not be judged, 1 stale data, 6 no bars
  OLDCO        STALE_DATA    its latest daily bar is 2026-06-02, not 2026-11-16
limits         Candidates, never signals: …
fingerprint    50b2…
kept           nothing (dry run)
```

| Field         | Meaning                                                                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database`    | The database read. Always `neelkanth_research` here                                                                                                                                                                                                                       |
| `scan`        | The day the scan is for, and the data day: the last trading day before it, whose daily bar every condition is judged on                                                                                                                                                   |
| `universe`    | How many F&O underlyings the symbol files hold, how many were left out (each named with why), and the minimum time to expiry                                                                                                                                              |
| `conditions`  | Each detector, its version and its rule in words. These are the only conditions                                                                                                                                                                                           |
| `status`      | `PARTIAL` with each reason beneath it. Always partial today: the ban list is not checked. Missing data adds a reason                                                                                                                                                      |
| `candidates`  | How many, then one line per candidate — underlying, bias (`BULLISH`, `BEARISH`, or `MIXED` when held conditions disagree), the data day's close, the future and its lot, the bar's date — and beneath it each condition that held with its evidence                       |
| `rejected`    | The count by reason — no condition held, could not be judged (too few bars, or volume not trusted), stale data (the latest bar is older than the data day), no bars — then one line for each except "no condition held", which `--all` adds with each condition's verdict |
| `limits`      | What a candidate is not. Repeat it with any answer                                                                                                                                                                                                                        |
| `fingerprint` | The hash of the result. Equal fingerprints are the same scan                                                                                                                                                                                                              |
| `kept`        | `nothing (dry run)`                                                                                                                                                                                                                                                       |

The values in the sample above are made up to show the format. Never quote
them as a result.

An index's volume is not trusted, so `HIGH_VOLUME_BREAKOUT` cannot judge an
index (its verdict is `VOLUME_NOT_TRUSTED`); the other two conditions still do.

A refusal ends the run with an `Error:` line and a stack. Report its first
line only:

- `refusing "<name>": the scan reads and writes only neelkanth_research or a scratch …`
  means the database was refused. Report it and stop.
- `<date> is not a trading day` means the exchange is shut that day. Ask for
  another.
- `--date is the IST trading day the scan is for` means the date is missing or
  malformed. Ask the operator for it.
- `symbol file … answered HTTP …` means the broker's public files could not be
  read. Say so; the scan cannot run without them.
- `MONGO_URI is not set` means `.env.local` holds no `MONGO_URI`. Say so; do
  not open the file.

If most underlyings are `no bars` or `stale data`, the daily bars for the data
day have not been fetched. Say so, and that the backfill needs the operator's
broker token; do not run it.

## Must not claim

- That a candidate should be bought or sold, or that it will move. It is a
  structure that completed at the data day's close, nothing more.
- That a candidate is tradable today. The ban list, open interest and price
  band are not checked, so it may be in the F&O ban period.
- That an underlying with no condition held is weak or strong. It means only
  that none of the three structures completed on that bar.
- That the scan saw today's price action. It reads daily bars strictly before
  the scan day.
- Anything about an option on the underlying. The conditions are the
  underlying's.

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
