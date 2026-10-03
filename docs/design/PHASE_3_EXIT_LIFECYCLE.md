# Phase 3 — Exit lifecycle

**Status: see [PLAN.md](../PLAN.md) §8.** Phase 3 is open; its task board
lives there and nowhere else. This document holds the decisions the board's
tasks implement — the precedent set by
[PHASE_1_HISTORICAL_DATA.md](PHASE_1_HISTORICAL_DATA.md) and
[PHASE_2_TRADE_LIFECYCLE.md](PHASE_2_TRADE_LIFECYCLE.md). Q1 and Q3, which
blocked implementation, are settled in §5.1; §8 audits the implementation
written before the phase opened against them.

Authorities: [PLAN.md](../PLAN.md) §8 for scope,
[ARCHITECTURE_DECISION.md](../architecture/ARCHITECTURE_DECISION.md) §9.3 for
the exit model (still `PROPOSED`, not `DECIDED`),
[CURRENT_STATE.md](../architecture/CURRENT_STATE.md) §4.1 for what exists.

---

## 1. Goal

> Every entry must be capable of reaching a deterministic outcome.
>
> Done when every simulated entry eventually produces
> `ENTRY → EXIT → COMPLETED TRADE`. No orphaned simulated entries.

Phase 2 built the record of an outcome. Phase 3 is what guarantees there is
one to record. An entry that never exits is not a trade with a missing field —
it is a decision with no result, and `Pattern → Strategy → Outcome` has nothing
to learn from.

---

## 2. What exists, and the shape of the gap

The Exit Engine is **present, wired and live** — a fact worth restating,
because it was once believed absent
([CURRENT_STATE §4.1](../architecture/CURRENT_STATE.md)). It reads open
positions, decides, and hands the exit to the same risk → order path a
strategy's signal takes. It has no broker of its own.

```text
ExitTrigger = "stop" | "target" | "square_off"     ← three, live
ExitReason  = STOP_LOSS TAKE_PROFIT STRATEGY_EXIT  ← seven, in the Trade
              TIME_EXIT SESSION_CLOSE
              MANUAL_EMERGENCY BROKER_RECONCILIATION
```

Phase 2 threaded the reason end to end and mapped the three that exist. **Four
have no producer**, and they are deliberately absent rather than approximated —
mapping a square-off onto `TIME_EXIT` because the names rhyme would put a claim
in the research dataset that no component ever made. Phase 3 is where three of
them acquire one.

| Missing                 | What has to exist first                             |
| ----------------------- | --------------------------------------------------- |
| `STRATEGY_EXIT`         | A way for a strategy to say "close this" — §4 D1    |
| `TIME_EXIT`             | Time-in-trade, measured from the entry fill — §4 D2 |
| `MANUAL_EMERGENCY`      | An operator route — §4 D5                           |
| `BROKER_RECONCILIATION` | A position closed by something we did not initiate  |

`BROKER_RECONCILIATION` is the odd one out and stays unproduced: it describes
discovering that a position went away without us asking, which belongs with
reconciliation rather than with exits.

---

## 3. The defect Phase 2 exposed

**The `exiting` guard is in-memory only.**
[exit-engine.ts](../../packages/engines/src/exit/exit-engine.ts) holds a
`Set<positionId>` so a position with an exit already in flight is not exited
twice. It does not survive a restart.

The window is real: hand off an exit, restart before the fill lands, and the
next session tick sees an open position with no record that anything was
already sent. It exits again. Two closing orders for one position — and under
Phase 2's model the second one is a **reversal**, so it does not merely
duplicate, it opens a new trade on the other side.

This is the same class of bug as the Trade Engine's fill idempotency (Phase 2
D5), and it wants the same answer: a durable check, consulted only when memory
does not already know.

---

## 4. Design decisions

### D1 — A strategy exits by saying so, not by proposing the opposite side

Today a strategy can only close a position by emitting an opposite-side signal
that the position engine nets against. That is indistinguishable from a
genuine reversal — and Phase 2's Q1 decided a reversal is **two trades**. So a
strategy that means "I'm done" produces one closed trade and one phantom
position in the other direction.

The verdict needs an explicit exit, and it must carry `STRATEGY_EXIT` so the
Trade records what actually happened.

**Open question (Q1):** does an exit verdict close the whole position, or a
quantity? A partial answer forces the scale-out question below.

### D2 — Time-in-trade is measured from the entry FILL

Not from the signal, and not from the order. `PENDING` is not `FILLED`
(ADR §9); a "hold for 30 minutes" rule measured from a signal that sat unfilled
for eight of them is not the rule anybody wrote.

The entry fill time is already on the Trade (`entryTime`) and on the Position
(`openedAt`). The Exit Engine reads positions, so `openedAt` is the natural
source — but the two must not be allowed to disagree, and the Trade is the one
research reads.

### D3 — The `exiting` guard becomes durable

Mirror Phase 2 D5: the in-memory `Set` stays as the fast path, and a miss
consults a durable record before acting. The candidate record already exists —
an open `Order` for that position with status `PLACED`/`PENDING` is precisely
"an exit is in flight".

**That needs the position → order edge**, which
[CURRENT_STATE §3.5](../architecture/CURRENT_STATE.md) says exists in neither
direction. Phase 2 added `positionId` to the Trade; the Order still has none.

### D4 — A trailing stop is a stop, not a fourth trigger

It changes _where_ the stop sits, not _why_ the position closed. It must report
`STOP_LOSS`, because a research question asking "how did my stops perform?"
means all of them.

This implies protective levels become mutable on an open position, which they
are not today — the Position carries `stopLoss` and `target` as written at
entry.

### D5 — Manual emergency exit is an operator route, behind step-up

Same gate as `PATCH /settings` and `POST /backfill`: it moves real money and
must not be a stray click. It reports `MANUAL_EMERGENCY`, which is the honest
label — an operator overrode the system, and a dataset that recorded that as
`STRATEGY_EXIT` would teach a strategy it did something it did not do.

### D6 — Square-off becomes opt-out, per strategy

Today `onSessionTick` flattens **every** open position at
`marketHours.squareOff` (15:12 by default), unconditionally, with no
per-strategy exemption. That is why
[PHASE_2 §5.4 Q3](PHASE_2_TRADE_LIFECYCLE.md)'s decision — an overnight
position stays one trade — currently costs nothing to honour: no position can
survive the night to test it.

**The default must stay "square off".** An intraday system that silently began
holding overnight because a config defaulted the other way is a much worse
failure than one that closes a swing position too early.

---

## 5. Open questions

| #   | Question                                                                                        | Why it blocks                                                              |
| --- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Q1  | Does a strategy exit close the whole position, or a quantity?                                   | A quantity means scale-out, which is the exit-legs array Phase 2 deferred. |
| Q2  | Is time-in-trade wall-clock or **session** time? Does an overnight hold count the closed hours? | A "60 minute" exit that fires at the next open is not what anyone wrote.   |
| Q3  | When a trailing stop and a take-profit both trigger on one bar, which wins?                     | Deterministic replay (Phase 4) needs one answer, not a race.               |
| Q4  | Does a strategy opting out of square-off also opt out of the daily-loss kill switch?            | Almost certainly not — but it must be stated, not assumed.                 |

**Q1 and Q3 blocked implementation, and are settled in §5.1.** Q2 and Q4 can
be settled against the first real dataset.

### 5.1 Q1 and Q3 — SETTLED

#### Q1 — a strategy exit closes the WHOLE position

| Case                                  | Outcome                                                |
| ------------------------------------- | ------------------------------------------------------ |
| Exit verdict, position held           | Closes the full quantity held when the exit is decided |
| `qtyProposal` on an exit verdict      | Ignored — the position's quantity is used              |
| Exit verdict while FLAT               | No-op, recorded as a HOLD. **Never an entry**          |
| Scale-out (close part, keep the rest) | **Not Phase 3.** Its own decision, later               |

"Close a quantity" is scale-out, and scale-out is not a smaller version of an
exit; it is a different decision with its own prerequisites:

- **How much, in what unit.** A derivative exits in whole lots (ADR §20.2:
  the lot is the unit), so "close 40%" needs the same lot-aware arithmetic the
  Risk Engine does for entries — on the exit path, which has none today.
- **What Phase 2 deferred.** A partially exited trade stays one trade (Phase 2
  Q2), but its weighted `exitPrice` is only right while nothing is added after
  a partial exit (Phase 2 §5.7, L3), and no per-leg record exists.

A whole exit needs none of that. And an exit verdict with nothing held must do
nothing: "I am done" while flat carries no side, and turning it into an order
would open exactly the phantom position D1 exists to prevent.

The Risk Engine needs no change: an exit is opposite-side to the held position,
which is how it already recognises a risk-reducing signal.

#### Q3 — a bar is judged against the levels it opened with; the stop wins a tie

1. **Each closed bar is judged against the stop and target as they stood when
   the bar opened.**
2. **A trailing stop moves after the bar is judged.** The bar's extreme sets
   the stop for the NEXT bar.
3. **When one bar touches both stop and target, the stop wins** — the existing
   rule (the Exit Engine's class note): an OHLC bar says nothing about which
   came first, and the favourable guess would flatter every backtest in the
   cases that hurt most.
4. **Precedence on one bar: stop, then target, then time.** A trailed stop
   still reports `STOP_LOSS` (D4).

Rules 1 and 2 are the answer to Q3's real question. A bar's high and low carry
no order; trailing from the high and then testing the low against the raised
stop ASSUMES the high came first. That assumption manufactures the very
"stop and target on one bar" case Q3 asks about, out of bars where it never
happened:

```text
LONG 100   stop 95   target 110   trail 2%
bar        high 111   low 105

judged first:   stop 95 untouched, target 110 touched   → TAKE_PROFIT
trailed first:  stop → 111 × 0.98 = 108.78, low 105 ≤ it → STOP_LOSS
```

`TAKE_PROFIT` is the truth in BOTH possible orderings: if the high came first,
110 filled on the way up; if the low came first, 105 never reached the stop of
95, and the target filled afterwards. The trailed-first answer is wrong either
way — and the stored Trade would say the stop failed where the target worked.

Judging first uses only levels that existed before the bar: PLAN.md rule 8's
"no future information", applied inside one bar. It is reproducible from OHLC
alone, which deterministic replay (Phase 4) needs. The cost is that a bar that
runs up and reverses exits one bar later than a tick-level trail would. That
errs late and deterministically, rather than inventing an intrabar order.

---

## 6. Proposed task order

| ID  | Task                                                                           | Depends on |
| --- | ------------------------------------------------------------------------------ | ---------- |
| 3.1 | Durable `exiting` guard; add `positionId` to `Order` (D3)                      | —          |
| 3.2 | Answer Q1 and Q3                                                               | —          |
| 3.3 | Strategy exit verdict → `STRATEGY_EXIT` (D1)                                   | 3.2        |
| 3.4 | Time-in-trade exit → `TIME_EXIT`, measured from the entry fill (D2)            | —          |
| 3.5 | Trailing stop, reporting `STOP_LOSS`; mutable protective levels (D4)           | 3.2        |
| 3.6 | Per-strategy square-off opt-out, defaulting to square off (D6)                 | —          |
| 3.7 | Manual emergency exit route, behind step-up (D5)                               | 3.1        |
| 3.8 | Integration: every simulated entry reaches a completed Trade — the "done when" | 3.3–3.7    |

The board — status, commits, evidence — is [PLAN.md](../PLAN.md) §8; this
table keeps only the dependencies.

3.1 first because every other exit path writes through the same guard, and a
guard that a restart can defeat makes each of them capable of producing a
phantom reversal.

---

## 7. Done when

Every simulated entry eventually produces `ENTRY → EXIT → COMPLETED TRADE`,
with no orphaned entries — and each completed Trade names the reason that
actually closed it, never a default.

Concretely: a replay in which a stop, a target, a strategy exit, a time exit
and a square-off each fire at least once leaves five closed Trades with five
different `exitReason` values, and no open position behind.

---

## 8. Audit of the staged implementation (2026-10-03)

Most of this phase was written before it opened, and sits **staged but not
committed** on `new-ai-agent-v1`, the way Phase 2's code once sat on a branch.
Like that port, it is audited rather than rewritten. Checked against §5.1 and
D1–D6; each finding names the task that must resolve it before it can close.

**Conforms:** the durable in-flight check through `Order.positionId` and its
index (D3); exits from the Exit Engine, the operator route and the runner all
close the whole position (Q1); the operator exit is behind step-up and reports
`MANUAL_EMERGENCY` (D5); square-off defaults to on (D6); stop beats time on
one bar (Q3 rule 4).

| #   | Finding                                                                                                                                                                                                                                                                                                                                           | Against    | Task       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- |
| A1  | **Trails before judging.** `onCandleClosed` moves the stop from the bar's high, then tests the bar's low against it. Run against the staged engine, the §5.1 bar reports `STOP_LOSS` where `TAKE_PROFIT` is the truth. The test "stops out at the trailed level on the bar that set it" pins that behaviour and must be inverted.                 | Q3         | 3.5        |
| A2  | **An exit verdict while flat can open a position.** The runner derives the closing side only when a position is held; otherwise it falls back to the verdict's own side, so `{ exit: true, side: "SELL" }` with nothing held is a SHORT entry.                                                                                                    | Q1         | 3.3        |
| A3  | **No strategy emits `exit: true`.** The runner can carry a strategy exit; nothing produces one, so §7's replay cannot show `STRATEGY_EXIT` firing.                                                                                                                                                                                                | D1, §7     | 3.3, 3.8   |
| A4  | **Exit rules cannot be set.** Neither `POST` nor `PATCH /strategies` accepts `exitRules`, so the time exit, the trailing stop and the square-off opt-out are reachable only by editing Mongo — the shape of Phase 2's `strategyVersion` gap.                                                                                                      | D2, D4, D6 | 3.4–3.6    |
| A5  | **Exit rules are captured at enable**, though `ExitPorts.readExitRules` says they are read per decision; and they are not in `strategyVersionOf`, though Phase 2's Q4 addendum says they belong there — a time exit changes what a strategy decides.                                                                                              | D2, D4, D6 | 3.4–3.6    |
| A6  | **Time-in-trade is measured from the wrong two clocks.** It subtracts `openedAt` from the bar's START timestamp, undercounting by one bar; and `Position.openedAt` is the projection's wall clock (`now()`), not the fill's `filledAt` — so it can disagree with `Trade.entryTime`, which D2 forbids, and in replay the two clocks are unrelated. | D2         | 3.4        |
| A7  | **A blocked exit is never retried in-process.** The engine marks the position `exiting` before the handoff, and the handoff returns nothing; when risk blocks the exit (session, duplicate), the position stays open with its guard set until a restart — an orphaned entry, which §7 forbids. Predates Phase 3.                                  | §7         | 3.1, 3.8   |
| A8  | **Stale and misplaced text.** The `EXIT_REASON` comment and the class note still say three triggers and four absent reasons; the `GET /trades` doc comment now sits above the manual-exit route, and `disable`'s above `exitRulesFor`.                                                                                                            | —          | as touched |

Q2 (wall-clock or session time) and Q4 (square-off opt-out vs. the daily-loss
gate) stay open. The staged code assumes wall clock, and leaves the daily-loss
gate untouched by the opt-out — consistent with Q4's "almost certainly not".

## Related documents

- [../PLAN.md](../PLAN.md) §8
- [../architecture/ARCHITECTURE_DECISION.md](../architecture/ARCHITECTURE_DECISION.md) §9.3
- [../architecture/CURRENT_STATE.md](../architecture/CURRENT_STATE.md) §4.1
- [PHASE_2_TRADE_LIFECYCLE.md](PHASE_2_TRADE_LIFECYCLE.md) — supplies `exitReason` and the Trade
