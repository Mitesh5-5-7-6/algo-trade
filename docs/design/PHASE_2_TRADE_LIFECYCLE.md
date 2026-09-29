# Phase 2 — Trade lifecycle

**Status: DESIGN. Phase 2 is not open.** PLAN.md §4 forbids skipping a phase
and §15 forbids implementing a future one early; Phase 1 is `IN PROGRESS`.
This document exists so that when Phase 1 closes, the phase starts with the
thinking already done — the same reason
[PHASE_1_HISTORICAL_DATA.md](PHASE_1_HISTORICAL_DATA.md) existed before Phase 1
opened.

Authorities: [PLAN.md](../PLAN.md) §7 for scope,
[ARCHITECTURE_DECISION.md](../architecture/ARCHITECTURE_DECISION.md) §9.2 for
the entity, [CURRENT_STATE.md](../architecture/CURRENT_STATE.md) §3.4 and §3.5
for what exists.

---

## 1. Goal

> Every completed position produces exactly one complete Trade.

```text
Signal → Order → Fill → Position → Active Trade → Exit → Completed Trade
```

A signal is not an outcome. An entry is not an outcome. Research labels
`Pattern → Strategy → Outcome`, and the Trade is the only record that can
supply the third term: what one decision actually earned, and why it ended.

---

## 2. The most important finding

**Most of Phase 2 is already written.** Branch `docs/architecture-baseline`
carries commit `5dac705`, which was deliberately deferred during the Phase 0
port because it belongs to this phase:

| File                                                    | What it holds                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/core/src/trade.ts`                            | `TradeSchema`, `ExitReasonSchema`, `grossPnlFor`, `netPnlFor`, `applyTradeFill` |
| `packages/db/src/trades-repository.ts`                  | Persistence and rank-free upsert                                                |
| `packages/db/src/trades-repository.integration.test.ts` | 168 lines against real Mongo                                                    |
| `packages/engines/src/trade/trade-engine.ts`            | Lifecycle, hydrate, `onOrderFilled` idempotency                                 |
| `packages/engines/src/trade/trade-engine.test.ts`       | 285 lines — open, close, partial exit                                           |
| `apps/api/src/engines/runtime.ts`                       | Wiring                                                                          |

**The honest move is to port it, not rewrite it** — exactly as tasks 1.1–1.4
were ported rather than reinvented. Phase 2's first task is therefore a
cherry-pick and an audit, not a blank page.

What the audit must check, because the branch predates three things that have
since landed:

1. **Candle provenance** (1.1). `dataProvenance` is a free-text field today.
   Now that bars carry `source`, `ingestedAt` and `ingestionVersion`, it should
   reference them rather than restate them in prose.
2. **The calendar moved to `core`** (1.4, `663547b`). Any import of
   `istDateKey` or `tradingDaysBetween` from `@neelkanth/engines` no longer
   resolves.
3. **`volumeAvailable` / `volumeQuality`** now exist. `marketContext` captured
   at entry should record whether the volume behind it was trustworthy, or a
   later study will treat `SUSPECT` volume as fact.

---

## 3. What exists today

| Piece                   | State                | Note                                                              |
| ----------------------- | -------------------- | ----------------------------------------------------------------- |
| `orders`, `positions`   | `EXISTS`             | Both written and read                                             |
| `trades` collection     | `MISSING`            | Not in the registry                                               |
| `trade_logs` collection | Declared, never used | Three indexes, a 90-day TTL, and **zero** read or write sites     |
| Entry ↔ exit linkage    | `MISSING`            | Reconstructed by joining positions to orders with no foreign key  |
| Exit lifecycle          | `PARTIALLY EXISTS`   | No strategy exit, no time exit, no trailing stop, no partial exit |

**`trade_logs` is a trap and must not be used.** It carries a 90-day TTL.
Completed trades are research evidence, and evidence that expires is a dataset
that quietly shrinks under whoever is studying it — a backtest run in March
against trades from January would silently see fewer of them than the same
backtest run in February. Trades belong in `trades`, untimed
([ARCHITECTURE_DECISION §10.4](../architecture/ARCHITECTURE_DECISION.md)).

---

## 4. Design decisions

### D1 — A Trade opens on the entry FILL, never on the signal

`PENDING` is not `FILLED` (ARCHITECTURE_DECISION §9). A trade created at signal
time would have to be deleted when the order is rejected, and a research
dataset that deletes rows is one whose history depends on when you read it.

The consequence worth stating: **a rejected or unfilled signal produces no
Trade at all**, and that is correct. "How often did this strategy propose?" is
a question about signals; "what did it earn?" is a question about trades. One
record cannot answer both without lying about one of them.

### D2 — Costs are stored beside the result, never folded into it

`grossPnl`, `charges`, `slippage` and `netPnl` are all persisted.

The position engine's `realizedPnl` subtracts charges as it goes, which makes
"what did this earn before costs?" unrecoverable afterwards. Cost sensitivity —
would this strategy survive doubled brokerage? — is one of the questions
research exists to answer, and it cannot be asked of a number that has already
absorbed the costs.

`netPnl` is **stored rather than derived** for the same reason in the other
direction: a later change to the cost model must not silently restate what
history earned.

### D3 — `quantity` is the peak, `openQuantity` is the remainder

The quantity remaining on a closed trade is always zero, so "how big was this
trade?" and "how much is still open?" cannot be the same field. Partial exits
make this load-bearing rather than pedantic.

### D4 — The Trade points at the Position, not the reverse

`positionId` lives on the trade. Research reads `Trade → Position`, and a
reverse pointer on the order would need a second write after the fill lands —
a new failure mode for a link already reachable.

### D5 — Idempotency is keyed on the fill, not the trade

`onOrderFilled` may be delivered twice: a broker can repeat an update, and a
restart re-reads what it did not finish. Applying the same fill twice would
double a trade's quantity and halve its apparent price. The engine must be
idempotent on `(orderId, filledAt)` and prove it with a test that replays the
same event.

### D6 — `exitReason` is recorded, never inferred

Seven reasons (ARCHITECTURE_DECISION §9.2): `STOP_LOSS`, `TAKE_PROFIT`,
`STRATEGY_EXIT`, `TIME_EXIT`, `SESSION_CLOSE`, `MANUAL_EMERGENCY`,
`BROKER_RECONCILIATION`.

A stop and a session square-off at the same price are the same number and
entirely different events: one is the strategy's risk rule working, the other
is the clock running out on a position that never resolved. A dataset that
cannot separate them will conclude the strategy's stops are fine.

**This is where Phase 2 meets Phase 3.** Several of these reasons have no
producer yet — there is no strategy exit and no time exit
(CURRENT_STATE §3.5). Phase 2 must accept the reason from whoever closed the
position and store `BROKER_RECONCILIATION` or `SESSION_CLOSE` honestly rather
than guessing a nicer one.

---

## 5. Open questions

None of these is guessable, and each changes the schema or the arithmetic.

| #   | Question                                                                                                      | Why it matters                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Does a **reversal** (long → short in one fill) end one trade and open another, or one trade with a remainder? | `applyTradeFill` already returns a remainder, so the code has an opinion. It needs confirming, because it decides the trade count. |
| Q2  | Do **partial exits** produce one trade with several exit legs, or several trades?                             | One trade with legs needs an exit-leg array the schema does not have. Several trades makes "how big was this trade?" ambiguous.    |
| Q3  | Does an **overnight position** remain one trade, or close at session end and reopen?                          | Decides whether a swing strategy is measurable at all.                                                                             |
| Q4  | What `strategyVersion` value is recorded, and who supplies it?                                                | A later edit to a strategy must not rewrite what past trades were made by. Nothing currently produces a version string.            |

**Q1 and Q2 block implementation.** Q3 and Q4 can be deferred to the first
real dataset, but not past it.

---

## 6. Proposed task order

| ID  | Task                                                                        | Depends on |
| --- | --------------------------------------------------------------------------- | ---------- |
| 2.1 | Port `5dac705`, audit against §2's three drifts                             | —          |
| 2.2 | Answer Q1 and Q2                                                            | —          |
| 2.3 | `trades` collection + indexes; confirm `trade_logs` stays unused            | 2.1        |
| 2.4 | `TradeEngine` fill idempotency proven by replaying one event (D5)           | 2.1        |
| 2.5 | Entry ↔ exit linkage: `entryOrderId`, `exitOrderId`, `positionId` populated | 2.1, 2.2   |
| 2.6 | `exitReason` threaded from whoever closes the position (D6)                 | 2.5        |
| 2.7 | Integration: a full round trip produces exactly one CLOSED trade            | 2.3–2.6    |
| 2.8 | `/trades` read route                                                        | 2.7        |

2.1 first is deliberate: everything else is an audit of ported code rather than
new work, and the port shrinks the phase considerably.

---

## 7. Done when

> Every completed position produces exactly one complete Trade.

Concretely: a paper round trip — signal, entry fill, exit fill — leaves exactly
one `trades` document with both order IDs, both prices, a populated
`exitReason`, and `grossPnl`, `charges` and `netPnl` all present and
independently checkable. Replaying the fill events changes nothing.

---

## Related documents

- [../PLAN.md](../PLAN.md) §7
- [../architecture/ARCHITECTURE_DECISION.md](../architecture/ARCHITECTURE_DECISION.md) §9.2, §10.4
- [../architecture/CURRENT_STATE.md](../architecture/CURRENT_STATE.md) §3.4, §3.5
- [PHASE_1_HISTORICAL_DATA.md](PHASE_1_HISTORICAL_DATA.md) — supplies `dataProvenance`
