# Phase 4 — Deterministic replay

**Status: see [PLAN.md](../PLAN.md) §9.** Phase 4 is open; its task board
lives there and nowhere else. This document holds the decisions the board's
tasks implement — the precedent set by the Phase 1–3 designs.

Authorities: [PLAN.md](../PLAN.md) §9 for scope,
[RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md)
Phase 4, §5.3 and §5.4 for research behaviour,
[CURRENT_STATE.md](../architecture/CURRENT_STATE.md) §4.2 for what exists.

---

## 1. Goal

> The same dataset, strategy, parameters and seed must produce the same
> result. Running the same replay twice produces identical results. Replay
> must never modify Paper or Live trading state.

```text
Market Data → Indicators → Strategy → Signal → Risk
→ Order → Fill → Position → Trade → P&L
```

Phases 2 and 3 made a decision's outcome recordable and guaranteed one exists.
Phase 4 makes it **reproducible**: research that cannot be re-run cannot be
checked, and a result nobody can reproduce is an anecdote.

---

## 2. What exists

### 2.1 The golden harness — real, and narrower than production

[apps/api/src/golden/pipeline.ts](../../apps/api/src/golden/pipeline.ts) wires
the real Position, PnL, Paper Broker, Order Manager, Risk, Indicator and
Strategy Runner engines over in-memory ports, with counter ids and the bar
timestamp as the clock. Its determinism test compares a run against a
committed record and against a second run. The spec's implementation target
is to **parameterise this, not build a second replay engine**.

What it lacks (CURRENT_STATE §4.2):

| Missing                         | Consequence                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------- |
| Exit Engine                     | The proof covers a machine with no exits — the one least able to make outcomes    |
| Market Data Engine / aggregator | It is handed finished candles; normalisation, aggregation and the flush never run |
| Market Bias Engine              | Hard-coded to an unknown market view                                              |
| Trade Engine                    | It records positions, not completed Trades — Phase 2's outcome primitive          |
| Historical input                | 60 synthetic sine-wave bars; nothing reads the Phase 1 dataset                    |
| Entry point                     | Runs only inside its test                                                         |

### 2.2 The most important finding — most of the first gap is already written

Branch `docs/architecture-baseline` carries commit `ed71384`. It is labelled as
the Phase 5 pattern detectors, and it also extends the golden harness: the
harness starts from **ticks**, runs the real Market Data Engine, Session
Manager, Market Bias Engine and **Exit Engine**, and drives square-off and the
end-of-day flush from session ticks. Its harness files carry no pattern code.
This is the "Phase 4 work" PLAN.md §4 says the branch holds.

**The honest move is to port it** — as Phase 2's task 2.1 ported `5dac705`.
What the audit must check, because it predates Phases 1–3:

1. **The Exit Engine's ports and handoff** changed in Phase 3 (durable guard,
   exit rules, stop updates, a handoff that reports whether an order was
   placed).
2. **There is no Trade Engine** — it predates Phase 2.
3. **Fill projection order**: since Phase 2 (L5) the runtime projects fills
   one at a time, position first. The harness must do the same, or it proves
   determinism of a machine that orders fills differently from production.
4. **Position times** now come from fills, and **candle provenance**,
   `strategyVersion` and `dataProvenance` now travel with every decision; the
   record should show what production would store.

**Audit outcome (task 4.1).** Ported in `b655476`; the ported record
reproduces byte for byte under today's engines.

| Point                             | Outcome                                                                                                                                                                                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Exit Engine ports and handoff | Wired as the runtime wires them: the in-flight check over the run's own orders, exit rules from the running instances, trails on the live position and its stored copy, and a handoff that reports whether an order was placed. Also: `istDateKey` now comes from core. |
| 2 — No Trade Engine               | Resolved in 4.3: the harness runs it, fills projected as the runtime projects them.                                                                                                                                                                                     |
| 3 — Fill projection order         | Already matches. The harness publishes inline, so each fill is projected before the next exists — the order the runtime enforces since Phase 2's L5.                                                                                                                    |
| 4 — What the record shows         | Resolved in 4.3: each Trade carries its exit reason, `strategyVersion` and entry-bar source.                                                                                                                                                                            |

### 2.3 The dataset

Phase 1 left one year of `BROKER_HISTORICAL` 5-minute bars for `NIFTY` and
`BANKNIFTY` in `neelkanth_research` (PLAN.md task 1.10): 247 trading days,
18,463 bars per index, readable through `CandlesRepository.findRange`.

---

## 3. Design decisions

### D1 — One pipeline, two sources

The harness accepts **either ticks or stored candles**. Ticks keep proving the
feed half — normalisation, aggregation, the flush — which every other number
depends on. Stored candles are what historical research has: the broker's
history is bars, not ticks, and reconstructing ticks from a bar would invent
an intrabar path the data does not contain. A candle source enters the same
pipeline at `CANDLE_CLOSED`; everything after it is shared.

### D2 — Time and identity come from the data, never the host

The clock is the bar (or tick) timestamp; ids are counters. Nothing reads
`Date.now()` or a random source. A run declares a `seed`, recorded in its
manifest; today nothing consumes it, and anything that ever introduces
randomness must draw from it rather than from the host.

### D3 — Replay is read-only against trading state

A run reads candles from the research database and writes **nothing** to the
trading collections (PLAN.md rule 7). Its orders, positions and Trades exist
in the run's own memory; where the result is kept is Q2.

### D4 — One strategy per run

Strategy isolation is `DECIDED` in the spec: running strategies together first
measures the shared capital and risk engine, not the strategies. A combined
portfolio simulation is a separate, later exercise.

### D5 — Every run declares what it was measured with

A run's manifest names the dataset (symbols, interval, date range, bar count,
sources, ingestion versions), the strategy and its `strategyVersion`, the
seed, and the model versions the spec requires (§5.3): position sizing, exit
model, slippage and transaction cost. The result carries a **fingerprint** — a
hash of its canonical serialisation — so "the same replay twice" is checked by
comparing two strings, not by eye.

### D6 — Days follow the trading calendar

A historical run steps trading days through `tradingDaysBetween` (Phase 1),
each with its session open, square-off and close. Indicator and strategy state
carry across days, and a position a strategy holds overnight (Phase 3 D6)
carries with it — one trade (Phase 2 Q3).

### D7 — No lookahead, enforced in a test

A decision at bar `t` sees only bars `≤ t` (spec §5.4). The candle source must
hand the pipeline bars in order and never let a window read past the bar being
decided; a test plants a future bar and proves no decision changes.

### D8 — Strategies that cannot be replayed refuse, rather than run blind

`INDEX_OPTION_PCR_OI` and `OPTION_MOMENTUM_SCALPER` need option-chain history,
which does not exist (spec Phase 6). Every derivative strategy needs contract
prices, which the index-only dataset does not have. A run refuses these by
name, rather than evaluating them against an absent chain or contract — which
they would read as "hold", producing a confident record of nothing.

---

## 4. Questions

| #   | Question                                                                                                                                                                                                                                                                 | Blocks |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Q1  | **What does a historical run of an index strategy trade?** The dataset holds indices, which are not tradable. Options: trade the index as a synthetic instrument (index points, quantity 1, labelled synthetic in the manifest), or refuse until futures history exists. | 4.4    |
| Q2  | **Where is a run's result kept?** In memory with a JSON artefact, or a `replay_runs` collection in `neelkanth_research` — never the trading database either way.                                                                                                         | 4.8    |
| Q3  | **Which cost and slippage models, at which versions?** [charges.ts](../../packages/broker/src/charges.ts) and [slippage.ts](../../packages/broker/src/slippage.ts) exist; neither carries a version yet.                                                                 | 4.5    |

**Q1 and Q2 blocked the tasks they name, and are settled in §4.1.** Q3 blocks
only the manifest's claim to name its models; it is settled with 4.5.

### 4.1 Q1 and Q2 — SETTLED

Settled with the recommendations this design made, when the phase was handed
over for development as a whole; either can be revisited without disturbing
the other.

#### Q1 — an index is replayed as a labelled synthetic instrument

| Case                                 | Outcome                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------ |
| An equity-style strategy on an index | Trades the index level itself, sized by the equity path, in index points |
| How the run says so                  | The manifest marks every such symbol `synthetic: true`                   |
| A derivative strategy                | Refused (D8) — there are no contract prices to fill against              |

Refusing until futures history exists would leave Phase 4 with nothing to
replay: the dataset is two indices. A synthetic instrument measures the
strategy's decision on the index's own path, which is what research on an
index asks — but its P&L is in index points, not rupees of a tradable
contract, and a reader must never mistake one for the other. Hence the label,
on the manifest every result carries, rather than in a comment.

#### Q2 — a run is kept in `replay_runs`, in the research database

One document per run, in `neelkanth_research` — never the trading database:
its manifest, its fingerprint, and its record (signals, orders, positions,
completed Trades). Untimed, like `trades`: a replay is research evidence, and
evidence on an operational TTL shrinks under whoever studies it (ADR §10.4).
Its Trades live inside the run, never in `trades`, so nothing that reads
production outcomes can mistake a replay for something that happened.

#### Q3 — SETTLED (task 4.5)

Each model carries a version beside its arithmetic — `CHARGES_MODEL_VERSION`,
`SLIPPAGE_MODEL_VERSION`, `SIZING_MODEL_VERSION`, `EXIT_MODEL_VERSION` — and a
run's manifest names all four together with the actual slippage model and
charge table it used: the version names the arithmetic, the configuration the
numbers. The first three are pinned by tests that map each version to its
outputs on fixed inputs, so changing the arithmetic fails until the outputs
move to a new version. The exit model is pinned by the golden record.

#### A finding of 4.4 — the session's final bar

The live feed releases a session's last bar only at the end-of-day flush: no
later tick pushes it out, so it arrives after the close and nothing decides on
it. A stored bar arrives at its own close. A historical replay therefore
decides on one more bar per session than live trading could — pinned in
`replay-source.test.ts` so it is never mistaken for a bug. Making the live
aggregator release that bar at the close would close the gap from the other
side; it is a change to live ingestion, recorded here rather than made.

---

## 5. Proposed task order

| ID  | Task                                                                                                                            | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 4.1 | Port `ed71384`'s harness extension — ticks, Market Data, Session Manager, Market Bias, Exit Engine — and audit it against §2.2  | —          |
| 4.2 | Answer Q1 and Q2                                                                                                                | —          |
| 4.3 | Trade Engine in the harness, fills projected in the runtime's order; the record carries completed Trades                        | 4.1        |
| 4.4 | Candle source: drive the same pipeline from stored bars, across trading days (D1, D6)                                           | 4.2, 4.3   |
| 4.5 | Run manifest and result fingerprint (D5); answer Q3                                                                             | 4.4        |
| 4.6 | One strategy per run; refuse what cannot be replayed (D4, D8); lookahead guard (D7)                                             | 4.4        |
| 4.7 | Prove read-only: a run writes nothing to the trading collections (D3)                                                           | 4.4        |
| 4.8 | Operator entry point over the research dataset, storing results per Q2                                                          | 4.5, 4.7   |
| 4.9 | Acceptance: replay a known historical week twice — identical fingerprints, Trades with every exit reason the strategy can reach | 4.8        |

4.1 first because it is a port, not new work, and it closes three of §2.1's
six gaps at once.

---

## 6. Done when

Replaying the same stored week with the same strategy, parameters, models and
seed twice yields identical fingerprints, with completed Trades carrying
their exit reasons — and the trading database is unchanged by either run.

---

## Related documents

- [../PLAN.md](../PLAN.md) §9
- [../architecture/RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md) Phase 4, §5.3, §5.4
- [../architecture/CURRENT_STATE.md](../architecture/CURRENT_STATE.md) §4.2
- [PHASE_1_HISTORICAL_DATA.md](PHASE_1_HISTORICAL_DATA.md) — the dataset
- [PHASE_3_EXIT_LIFECYCLE.md](PHASE_3_EXIT_LIFECYCLE.md) — the exits a replay must reach
