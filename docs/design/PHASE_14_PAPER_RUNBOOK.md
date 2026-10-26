# Phase 14 — Paper session runbook

How the operator runs one paper validation session, drills a restart, and
reads the session's report. Decisions are in
[PHASE_14_PAPER_VALIDATION.md](PHASE_14_PAPER_VALIDATION.md); status is in
[PLAN.md](../PLAN.md) §19 and nowhere else.

Commands run from `apps/api`, against the **built** code (`pnpm build` first),
with an env file for the paper environment — called `.env.paper` here.

---

## 1. Once: the paper environment

| What           | Value                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROKER_MODE`  | `paper`                                                                                                                                         |
| `MONGO_URI`    | a database named `neelkanth_paper` (or `neelkanth_paper_<name>` for a drill). The process refuses any other (D2).                               |
| `REDIS_URL`    | the **paper** Redis instance. Keys carry no environment, so a Redis shared with live would cross the daily-loss counter and hot state (ADR §8). |
| `FYERS_APP_ID` | the app's id and secret: market data only. In paper the broker is built without order capability (D2).                                          |

Then:

1. `pnpm build`
2. Create the operator account on the paper database:
   `node --env-file=../../.env.paper dist/bootstrap-operator.js`
3. **Warm-up bars.** Live indicators warm from stored bars, and so does the
   parity replay — from ten days before the session. A new paper database
   holds none, so backfill the subject's symbols into it with
   `scripts/backfill-candles.mts` (its header gives the arguments), run with
   `MONGO_URI` naming the paper database. Without it, count the first
   sessions as warm-up, not acceptance.
4. Provision the test subject (D1):

   ```sh
   node --env-file=../../.env.paper scripts/paper.mts provision
   ```

   ORB and EMA_CROSSOVER on `NSE:NIFTY50-INDEX` and `NSE:NIFTYBANK-INDEX`,
   enabled, marked `subject`, never promotable. Provisioning again leaves
   whatever is there untouched. Indices are traded as the replay trades them —
   lot 1, in index points — in paper only.

---

## 2. Each session

**Before 09:00 IST**

1. Start the process: `node --env-file=../../.env.paper dist/main.js`.
   Strategies are enabled at boot, so provisioning must come first.
2. Complete the FYERS login from the dashboard. The token expires daily; the
   feed cannot connect without it.
3. On the status strip: feed **LIVE**, engine **RUNNING**, and the
   evaluations count rising once bars start closing after 09:15.

A `BROKER_DISCONNECTED` / `BROKER_CONNECTED` pair every couple of minutes
means the feed is subscribed to nothing — no strategy enabled — and FYERS is
dropping the idle socket. Check the subject is provisioned and enabled, and
look for "market data working set is EMPTY" in the log.

**Through the day** keep the process running. The session is not settled until
the process sees the close: at the 15:30 transition it flushes the last bar,
cancels pending LIMIT orders, and reconciles the book (the CLOSE run).

**After 15:31**

```sh
node --env-file=../../.env.paper scripts/paper.mts report
```

Reports today's session (`--session=YYYY-MM-DD` for another) and keeps it in
`paper_session_reports`; `--dry-run` keeps nothing. `reports` lists the latest
report of each session.

---

## 3. Reading the report

The session is **CLEAN** when all three hold:

| Check          | Means                                                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| reconciliation | a CLOSE run happened, and every run that day — BOOT and CLOSE — found the book and the trading state in agreement. "missing CLOSE": the process was down at the bell. |
| flat           | no Trade left open after square-off.                                                                                                                                  |
| parity         | the replay of the session's own bars made the same decisions (D6), within the declared tolerance.                                                                     |

Every parity difference is listed, never averaged:

| Kind               | Means                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SIGNAL`           | a decision on a bar that the other side did not make, or with another exit reason.                                                                          |
| `RISK`             | the same signal, a different risk verdict.                                                                                                                  |
| `TRADE`            | a Trade on one side only; or quantity, exit reason, or a price, exit time, gross P&L or charges beyond tolerance (10 bps entry, 50 bps exit, one bar, 1 %). |
| `STRATEGY_VERSION` | the strategy was edited after it decided — every match after that is moot.                                                                                  |
| `REPLAY`           | the replay could not run a strategy (no bars for its symbol, an option chain, a derivative) — its decisions have nothing to be held against.                |

A difference is a finding to explain in the acceptance log, not a number to
tolerate. The orders section shows each fill's slippage against the price the
decision saw — positive is adverse.

**A reconciliation mismatch halts trading** for the rest of the session (D4):
`SYSTEM_ERROR` on the dashboard, the detail in `risk_events`. Resolve the
cause, then resume through `/control/resume` (step-up). The session it
happened in is not clean.

---

## 4. The restart drill (D7)

On at least one acceptance session, ideally while a position is open:

1. Between 10:30 and 14:30, stop the process (Ctrl+C, or kill it).
2. Wait a minute; start it again exactly as in the morning.
3. At boot, it restores positions, open Trades, the day's realized loss and
   strategy state, settles in-flight orders from the paper book, and
   reconciles (a BOOT run). No `SYSTEM_ERROR` should appear.
4. After the close, report as usual. The report lists the restart under
   **restarts**, and the drill passes when the session is **CLEAN**: no
   duplicate order (an order is unique by its signal), positions and P&L
   continuous, every run clean, the replay in agreement.

A late first start is not a restart: a BOOT after the bell counts only when
an earlier BOOT came the same day.

---

## 5. The acceptance log (14.7)

Five live sessions, at least one with the drill; each reported and
parity-checked; reconciliation clean (D8). For each: the date, the report id,
CLEAN or not, the restart if drilled, and every difference with its
explanation.
