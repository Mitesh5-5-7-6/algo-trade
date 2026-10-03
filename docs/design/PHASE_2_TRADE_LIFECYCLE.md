# Phase 2 — Trade lifecycle

**Status: see [PLAN.md](../PLAN.md) §7.** Phase 2 is open; its task board
lives there and nowhere else. This document holds the decisions the board's
tasks implement. It was written before the phase opened, so it would start
with the thinking already done — the same reason
[PHASE_1_HISTORICAL_DATA.md](PHASE_1_HISTORICAL_DATA.md) existed before Phase 1
did.

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

### 2.1 Audit outcome (task 2.1)

| Drift                  | Outcome                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — `dataProvenance`   | Now `DataProvenanceSchema`: the candle store's key `(symbol, interval, barTs)` for the bar the entry decision was made on, plus a **snapshot** of its `source` and `ingestionVersion`. The snapshot is needed because a backfill may later overwrite the LIVE_TICK bar at that key with the broker's record. For a derivative, the key names the analysed underlying's bar. |
| 2 — calendar in `core` | Does not apply. No trade code imports the calendar.                                                                                                                                                                                                                                                                                                                         |
| 3 — volume quality     | `marketContext` is now `EntryMarketContextSchema`: the decision bar's `volumeAvailable` and `volumeQuality`, copied exactly and never defaulted. `{}` means captured, with the bar saying nothing; absent means not captured. Trend, volatility and VWAP belong to the phases that compute them.                                                                            |

Both are stamped by the Strategy Runner, the only component holding the bar at
decision time, and copied forward Signal → Order → `ORDER_FILLED` → Trade — the
road `strategyVersion` takes (Q4). They are set once, when a trade opens; a
reversal's new trade takes the reversing order's bar, because that order is
its entry decision. An Exit Engine signal carries neither: it is not an entry.

The audit also found one port drift: `trades-repository.integration.test.ts`
predated the §0.4 probe and connected unconditionally, so without MongoDB
`pnpm test` failed and stopped turbo before the engines and api suites ran.

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

## 5. Questions

### 5.1 Q1 and Q2 — SETTLED

**A Trade represents a complete trading lifecycle, not a broker order.** That
single sentence decides both, and is the reason to record it here rather than
leave it implied by the code.

#### Q1 — a reversal is TWO trades

A fill that crosses through flat — long 50, a SELL 80 arrives — closes the
long and opens a short of 30.

```text
LONG  Trade #1   entry → … → exit 50 → CLOSED
SHORT Trade #2   entry 30 → …
```

Both "what did the long earn?" and "how is the short doing?" must stay
independently answerable, and one merged record can answer neither.

This confirms what `applyTradeFill` already does. **What it does NOT confirm**
is the cost handling. The remainder is currently built with `charges: 0,
slippage: 0`, which avoids a double-count by attributing the whole order's
cost to the closing trade — so the closing trade pays for the new entry and
the new trade appears to enter for free. Both figures are wrong, in opposite
directions, and cost sensitivity is exactly what D2 keeps costs separate to
measure.

**Allocate pro-rata by quantity:**

```text
order qty 80   =   closing 50   +   opening 30

closingCost = totalCost × 50/80      (62.5%)
openingCost = totalCost × 30/80      (37.5%)
```

The same rule applies to slippage wherever the broker reports it at order
level rather than per leg.

**Rounding is part of the decision, not an implementation detail.** Rounding
each leg independently lets the parts drift from the whole, and a cost that
does not reconcile is worse than one that is slightly misallocated — the
first is undetectable, the second is auditable. Allocate deterministically
and give any remainder to one leg, normally the last:

```text
sum(allocated costs) === original fill cost      (at the model's precision)
```

#### Q2 — a partial exit is ONE trade, with a weighted-average exit price

`LONG 100`, then `SELL 30`, `SELL 30`, `SELL 40`, is one lifecycle:

```text
Trade #1   100 → 70 → 40 → 0 → CLOSED
```

Not three trades. Accumulating `grossPnl` and `charges` across the legs is
already correct; the defect is `exitPrice`, which is overwritten by the
latest leg. On a trade exited in tranches it therefore means "the price of
the last tranche", so the obvious research arithmetic disagrees with the
stored result and nothing says which is right:

```text
(exitPrice − entryPrice) × quantity   ≠   grossPnl
```

**Store the quantity-weighted mean instead**, mirroring what the entry side
already does when a position is added to:

```ts
entryPrice = (entryPrice * held + fill.price * fill.qty) / newHeld;
```

```text
entry   100 @ 100
exits    30 @ 110,  30 @ 115,  40 @ 120

exitPrice = (30×110 + 30×115 + 40×120) / 100 = 115.50
grossPnl  = (115.50 − 100) × 100            = 1,550
```

The record is then internally consistent, and the two sides of it are
symmetric.

**An exit-legs array is deliberately NOT added.** It is the more faithful
representation, but it introduces a second data model to solve a Phase 3
problem before anything produces partial exits at all. The Trade is the
research-level summary; execution-level detail belongs in fill records, which
can be added later without disturbing it.

### 5.2 The resulting rules

| Scenario          | Trades | `entryPrice`     | `exitPrice`      | Costs             |
| ----------------- | ------ | ---------------- | ---------------- | ----------------- |
| Entry → full exit | 1      | entry price      | exit price       | full lifecycle    |
| Multiple entries  | 1      | weighted average | exit price       | accumulated       |
| Partial exits     | 1      | weighted average | weighted average | accumulated       |
| Reversal          | 2      | independent      | independent      | split by quantity |

### 5.3 Invariants

These matter more than any particular implementation: they are what lets R&D
trust the numbers instead of reverse-engineering what the execution code
probably meant six months earlier.

For a closed trade:

```text
grossPnl  ≈  direction × (weightedExitPrice − weightedEntryPrice) × quantity
netPnl    =  grossPnl − charges
```

For a reversal:

```text
closingTrade.cost + openingTrade.cost  =  originalFill.cost
```

**One thing to settle before these are written as law.** The invariant was
stated as `netPnl = grossPnl − charges − otherCosts`. There is no
`otherCosts` field, and if it is meant to be `slippage`, subtracting it would
**double-count**: slippage is the gap between the expected and actual fill
price, so it is already inside `entryPrice` and `exitPrice`, and therefore
already inside `grossPnl`. `netPnlFor` says exactly this today —
`grossPnl − charges`, with slippage stored for measurement but never
subtracted. The formula above keeps that. If `otherCosts` means something
else — financing, borrow, STT handled outside `charges` — it needs a field
and a definition, and should be raised as Q5 rather than folded in silently.

### 5.4 Q3 and Q4 — SETTLED

#### Q3 — an overnight position stays ONE trade

|                                |                                                                        |
| ------------------------------ | ---------------------------------------------------------------------- |
| Overnight position             | One trade, remains `OPEN` across sessions                              |
| Automatic close at session end | **No** — the Trade entity never closes a trade for bookkeeping reasons |
| Intraday strategy wants out    | It emits an explicit exit                                              |
| New trade next morning         | No, unless an actual new entry occurs                                  |
| Overnight research measurable  | Yes                                                                    |

A trading day boundary is a fact about the exchange, not about the decision
being measured. Closing a trade at 15:30 and opening a replacement at 09:15
would turn one three-day swing into three trades, none of which earned what
the swing earned, and would make swing strategies unmeasurable by
construction.

> **Gap this exposes.** The decision is a rule about the Trade entity, and as
> such it holds. But "overnight research measurable: yes" presumes a position
> _can_ survive the night, and today none can:
> [exit-engine.ts](../../packages/engines/src/exit/exit-engine.ts)
> `onSessionTick` flattens **every** open position at
> `marketHours.squareOff` — 15:12 by default — and
> [runtime.ts](../../apps/api/src/engines/runtime.ts) drives it
> unconditionally on every session tick while the market is open. There is no
> per-strategy opt-out.
>
> So Q3 costs nothing to honour now — it simply never triggers, because
> square-off closes everything first. It becomes real only when a strategy
> can decline the flatten, which is exit-lifecycle work (Phase 3,
> CURRENT_STATE §3.5). **Recorded rather than resolved here**, because
> quietly adding an opt-out would be Phase 3 work done early.

This does not retire the `SESSION_CLOSE` exit reason. Square-off is a real
trading action producing a real fill, and a trade closed by it is closed for
that reason. What Q3 forbids is a trade ending because a date changed.

#### Q4 — `strategyVersion` is stamped by the Strategy Runner and never rewritten

|                                           |                                                  |
| ----------------------------------------- | ------------------------------------------------ |
| Supplied by                               | The strategy / Strategy Runner, at decision time |
| Stored on Signal                          | Yes                                              |
| Stored on Order                           | Yes                                              |
| Stored on Trade                           | Yes                                              |
| Historical value mutable                  | **No**                                           |
| A later strategy edit rewrites old trades | **Never**                                        |
| Exact-code identity                       | A `strategyRevision` / commit hash, later        |

Carrying it on all three is not redundancy. Each is written at a different
moment by a different component, and a trade whose version had to be looked
up through its order would lose it the moment orders are pruned. The value
is copied forward, never referenced.

> **Scope this exposes.** None of it exists yet:
> [strategy.ts](../../packages/core/src/strategy.ts) has no version field,
> and neither [signal.ts](../../packages/core/src/signal.ts) nor
> [order.ts](../../packages/core/src/order.ts) carries `strategyVersion` —
> all three hold `strategyId` alone. `TradeSchema` is the only one already
> ready for it, and there it is optional.
>
> Q4 is therefore a change across four places: a version on
> `StrategyConfig`, the field on `SignalSchema` and `OrderSchema`, and a
> producer in the Strategy Runner. Each field must be optional, for the same
> reason `source` was defaulted rather than required — every signal, order
> and trade already in Mongo predates it, and a required field throws on the
> first read after deploy.

### 5.5 The lifecycle these decisions define

```text
Strategy
   │  strategyId + strategyVersion
   ▼
Signal  ──▶  Risk  ──▶  Order  ──▶  Execution
                                        │
                                        ▼
                                      Trade
                                        ├── spans multiple sessions
                                        ├── absorbs partial exits
                                        ├── a reversal starts a new one
                                        └── strategy identity is immutable
```

What this buys is a historical dataset of decisions rather than a pile of
broker-order-shaped accidents — which is the difference between research that
can attribute an outcome to a strategy version and research that cannot.

### 5.6 Still open

| #   | Question                                                                                                                                                                                                                                                                 | Raised by |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| Q5  | Does `netPnl` subtract anything beyond `charges`? If `otherCosts` means financing, borrow or STT handled outside `charges`, it needs a field and a definition. It must **not** mean `slippage`, which is already inside the fill prices and therefore inside `grossPnl`. | §5.3      |

Q5 does not block the port. It blocks calling `netPnl` final.

### 5.7 Known limits, found by the 2.1 audit

Recorded rather than fixed in 2.1, whose scope was the port. Each needs a
decision when its task is closed.

| #   | Limit                                                                                                                                                                                                                                                                                                                  | Bears on |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| L1  | **A redelivered scale-in fill is applied twice after a restart.** The durable idempotency lookup matches only `entryOrderId` and the latest `exitOrderId`, so an ADD leg's order is unrecognisable. Nothing in the Risk Engine refuses a same-side add to a filled position.                                           | 2.4, D5  |
| L2  | **Memory moves before Mongo.** The engine marks a fill applied and updates its open trade before `saveTrade` resolves. A failed save leaves the process ahead of the store, and if a reversal's second save fails, the new trade is lost for good: after a restart the order is found on the closed trade and skipped. | 2.4, D5  |
| L3  | **`exitPrice` assumes no add after a partial exit.** It derives "already exited" from the peak `quantity`, which stops being "total entered" once a reduced position is added to. Nothing produces partial exits yet (Phase 3).                                                                                        | §5.1 Q2  |
| L4  | **`entrySignalId` / `exitSignalId` are never populated**, because `ORDER_FILLED` carries no `signalId`. The link remains reachable through `entryOrderId` → order → `signalId`.                                                                                                                                        | 2.5      |

---

## 6. Proposed task order

| ID  | Task                                                                                                                                               | Depends on |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 2.1 | Port `5dac705`; audit against §2 three drifts **and apply §5.1 two corrections** — pro-rata cost split on a reversal, weighted-average `exitPrice` | —          |
| 2.2 | ~~Answer Q1 and Q2~~ — **settled, §5.1**. Q3 and Q4 settled too, §5.4                                                                              | —          |
| 2.3 | `trades` collection + indexes; confirm `trade_logs` stays unused                                                                                   | 2.1        |
| 2.4 | `TradeEngine` fill idempotency proven by replaying one event (D5)                                                                                  | 2.1        |
| 2.5 | Entry ↔ exit linkage: `entryOrderId`, `exitOrderId`, `positionId` populated                                                                        | 2.1, 2.2   |
| 2.6 | `exitReason` threaded from whoever closes the position (D6)                                                                                        | 2.5        |
| 2.7 | Integration: a full round trip produces exactly one CLOSED trade                                                                                   | 2.3–2.6    |
| 2.8 | `strategyVersion` on `StrategyConfig`, `SignalSchema`, `OrderSchema`, stamped by the Strategy Runner (Q4) — all optional                           | 2.1        |
| 2.9 | `/trades` read route                                                                                                                               | 2.7        |

**Not in Phase 2:** a per-strategy square-off opt-out. Q3's rule holds without
it; what it unlocks is positions that actually survive the night, and that is
Phase 3 exit-lifecycle work. Building it here would be implementing a later
phase early.

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
