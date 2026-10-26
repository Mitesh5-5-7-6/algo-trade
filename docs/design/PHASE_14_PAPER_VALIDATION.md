# Phase 14 — Paper validation

**Status: see [PLAN.md](../PLAN.md) §19.** Phase 14 is open; its task board
lives there and nowhere else. This document holds the decisions the board's
tasks implement.

Authorities: [PLAN.md](../PLAN.md) §19 for scope;
[ARCHITECTURE_DECISION.md](../architecture/ARCHITECTURE_DECISION.md) §8
(Paper owns its own database and Redis; FYERS order credentials never in
Paper), §12 (PAPER VALIDATION in the promotion chain), §13.1 (Paper ──✗──▶
FYERS order placement; read-only market data permitted), §5.8 (fail closed);
[RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md)
Phase 14.

---

## 1. Goal

> Candidate runs against real-time market data without real money. Validate
> signals, execution, fills, slippage, risk, positions, exits, P&L, restart
> recovery and broker reconciliation.

No candidate has passed Phase 13's gate (Phase 13 §7, W1). So Phase 14
validates **the paper pipeline itself**, on a declared **test subject** — an
existing strategy as configured, marked as a subject, never a candidate,
never promotable — on the **live market**, so that the day a candidate
passes, its paper validation is a run, not a build.

---

## 2. What exists

- **A paper runtime** (`BROKER_MODE=paper`): the production composition with
  FYERS's read-only market-data websocket and a `PaperBroker` for orders
  ([composition-root.ts](../../apps/api/src/composition-root.ts) lines
  203–238); bars built live from ticks (1m and 5m), persisted to `candles`.
- **Restart survival** of the daily-loss ledger, strategy state, open
  positions and Trades (Phase 0; `runtime.ts` 870–958).
- **Deterministic replay** of the same engines over stored bars (Phase 4) — the
  reference a paper session is held against.

### 2.1 What a live paper run would break on

| #   | Gap                                                                                                                                                                                      | Where                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| G1  | `PaperBroker` keeps its order statuses in memory only and no fills book: after a restart every in-flight order reconciles "unknown" and stays PLACED/PENDING forever.                    | `paper-broker.ts` 49, 100; `order-manager.ts` 302–378 |
| G2  | No position reconciliation against the broker; `BROKER_RECONCILIATION` is defined and never produced.                                                                                    | `trade.ts` 33; `exit-engine.ts` 10–12                 |
| G3  | Nothing ties the mode to a database: a paper process can run against the research or the live database. Paper and Live are meant to own separate databases and Redis instances (ADR §8). | `config/src/index.ts`                                 |
| G4  | In paper mode a full `FyersBroker` is built when FYERS app credentials exist; order placement is kept from it by wiring alone.                                                           | `composition-root.ts` 164–235                         |
| G5  | A paper LIMIT order that has not crossed returns PENDING and is never monitored.                                                                                                         | `paper-broker.ts` 72–87                               |
| G6  | Nothing records what a paper session did, or holds it against what the replay of the same bars decides.                                                                                  | —                                                     |

### 2.2 The decisions taken at opening

**Q1 — validate the paper pipeline itself**, by the operator, on a test
subject (D1).

**Q2 — on real-time market data**, by the operator: the acceptance is paper
trading on the live market over real sessions (D8).

---

## 3. Design decisions

### D1 — A test subject, never a candidate

The subject is an existing replayable strategy as configured — ORB and
EMA_CROSSOVER on NIFTY 50 and NIFTY BANK, which trade often enough to exercise
every path — provisioned into the paper database marked `subject`, with no
candidate id. A paper run of a subject can make nothing eligible for
promotion (ADR §12). When a candidate passes Phase 13, its paper run is the
same procedure with the candidate's id.

The mark is the strategy config's `validation` — `{ role: "subject" }`, or
`{ role: "candidate", candidateId }` — outside the strategy version.

An index is not in the live symbol master: FYERS lists NIFTY 50 and NIFTY
BANK with a lot size of 0, the master drops such rows, and risk refused every
entry on the subject as "lot size unknown". So in paper — never in live,
where no index contract exists — a traded index is the replay's synthetic
instrument (Phase 4 Q1): lot 1, in index points. One definition serves the
replay and the paper runtime, so a session and the replay it is held against
size the same Trade the same way (operator's decision, 14.6).

### D2 — Paper is its own environment, and says so

A paper process **refuses to start** unless its database is a paper one
(`neelkanth_paper`, or `neelkanth_paper_*` for a drill), never the research,
live or test databases; a live process refuses a paper database. Its Redis
is the operator's paper instance (ADR §8 — keys carry no environment, so a
shared instance would cross paper and live counters). In paper mode FYERS is
built **without order capability**: placing an order through it throws, so
the boundary is code, not wiring (G4).

### D3 — The paper broker keeps a book that survives a restart

Every paper order, its status and its fill (price, quantity, charges,
slippage, time) is kept in the paper database as the broker's own record
(`paper_broker_orders`), written before the fill is reported. After a
restart `status()` answers from it, so boot reconciliation settles every
in-flight order (G1). The broker's positions are the sum of its fills.

### D4 — Reconciliation, and fail closed

At boot and at the session close the trading state — open positions and the
day's orders — is held against the broker's book: each symbol's net
quantity, each order's status and fill. A mismatch is recorded as a risk
event, and **new entries are refused** for the rest of the session until the
operator clears it (ADR §5.8); a position the broker shows closed but the
trading state shows open is closed at the broker's price with exit reason
`BROKER_RECONCILIATION` (G2).

The mismatch is durable in `risk_events`, surfaced as `SYSTEM_ERROR`, and
turns off the persisted trading kill flag. After resolving the discrepancy,
the operator clears the halt through the step-up-protected `/control/resume`.
When the paper book is flat for a symbol but local positions remain open, the
Order Manager records a deterministic reconciliation close from the book's
latest fill and projects it through the normal position and Trade engines; it
does not submit another broker order. The fill's slippage and charges are
prorated by quantity across all local positions closed for that symbol.

### D5 — Limit orders are watched

A pending paper LIMIT order is evaluated against each normalized live tick for
its symbol and fills at its limit price on the first tick that satisfies it:
BUY when the tick is at or below the limit, SELL when at or above. The paper
broker book is the source of pending orders, so monitoring resumes after a
restart. Any order still pending at the session-close transition is cancelled
with reason `session closed`, and the normal broker update path marks the
trading order cancelled. It is never carried into the next session (G5).

### D6 — A session report, held against the replay

After each session, from the paper database: every signal, risk decision,
order, fill (with slippage against the decision price), Trade, exit reason,
the day's P&L and the reconciliation result, and any restart — kept in
`paper_session_reports`. Then the **parity check**: the subject replayed
(Phase 4) over that same session's bars — the bars the paper run itself
built — and compared decision by decision: the same signals on the same bars,
the same Trades entered and exited on the same bars and for the same
reasons; fill prices and P&L differing only by tick-against-bar timing,
within a declared tolerance. Every difference is listed, not averaged.

The replay starts from the backtest's warm-up lead — the live indicators are
warmed from stored bars too — with the paper settings' index and breadth
symbols, capital and limits, and compares only the session's own decisions.
The declared tolerance (`PARITY_TOLERANCE`, version 1): entry price 10 bps,
exit price 50 bps, exit time one decision bar, gross P&L by both legs' price
room, charges 1 %. Every reconciliation run, BOOT and CLOSE, clean or not, is
kept in `paper_reconciliations`, since a clean run writes no risk event; a
BOOT after the bell that follows an earlier BOOT is a restart. A session is
clean when it was reconciled clean at the close, ended flat, and the replay
agreed throughout.

### D7 — Restart recovery is drilled, not assumed

During a live session the process is stopped and started again: the run
must continue with no duplicate order, its positions, daily loss and
strategy state restored, every in-flight order reconciled, and the session
report and parity check still clean.

### D8 — Acceptance: live sessions (Q2)

The paper runtime, with the subject enabled, on the live market for five
trading sessions, at least one with a restart drill; each session reported
and parity-checked; reconciliation clean. The operator keeps the process
running through market hours and the FYERS market-data token current — a
run in calendar time, reported session by session.

---

## 4. Open decisions

| #   | Question                                | Decided                                                                                                                                                                                  |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | What Phase 14 validates first           | **The paper pipeline itself**, on a test subject, by the operator at opening.                                                                                                            |
| Q2  | What the acceptance runs on             | **Real-time market data**, paper trading, by the operator at opening.                                                                                                                    |
| Q3  | The subject, and the number of sessions | **ORB and EMA_CROSSOVER on NIFTY 50 and NIFTY BANK, indices traded as lot-1 synthetic instruments in paper**, by the operator at 14.6; five sessions, one with a restart drill (D1, D8). |
| Q4  | The paper Redis instance                | The operator's to supply at 14.1 (D2).                                                                                                                                                   |

---

## 5. Proposed task order

| ID   | Task                                                                                                           | Depends on |
| ---- | -------------------------------------------------------------------------------------------------------------- | ---------- |
| 14.1 | The paper environment: mode tied to its database, FYERS without order capability in paper (D2)                 | —          |
| 14.2 | The paper broker's book: orders and fills kept, a restart's in-flight orders settled (D3)                      | 14.1       |
| 14.3 | Reconciliation against the book at boot and close, entries refused on a mismatch, `BROKER_RECONCILIATION` (D4) | 14.2       |
| 14.4 | Watched paper limit orders (D5)                                                                                | 14.2       |
| 14.5 | The session report and the parity check against the replay (D6)                                                | 14.3       |
| 14.6 | The test subject, provisioned; the paper session runbook and CLI; the restart drill (D1, D7)                   | 14.5       |
| 14.7 | Acceptance: five live paper sessions, one with a restart, each reported and parity-checked (D8)                | 14.6       |

---

## 6. Done when

The paper runtime runs only on a paper database, cannot place a real order,
and keeps a broker book that survives a restart; reconciles it at boot and
close, failing closed on a mismatch; and, over five live sessions of a test
subject — one restarted mid-session — reports every signal, order, fill,
Trade and P&L, with the replay of the same bars agreeing decision for
decision and every difference named.

---

## Related documents

- [../PLAN.md](../PLAN.md) §19
- [PHASE_14_PAPER_RUNBOOK.md](PHASE_14_PAPER_RUNBOOK.md) — running a session, the restart drill, reading the report
- [PHASE_4_DETERMINISTIC_REPLAY.md](PHASE_4_DETERMINISTIC_REPLAY.md) — the replay a session is held against
- [PHASE_13_BACKTEST_WALK_FORWARD.md](PHASE_13_BACKTEST_WALK_FORWARD.md) — the gate no candidate has passed yet
