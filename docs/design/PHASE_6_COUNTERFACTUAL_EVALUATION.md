# Phase 6 — Counterfactual strategy evaluation

**Status: see [PLAN.md](../PLAN.md) §11.** Phase 6 is open; its task board
lives there and nowhere else. This document holds the decisions the board's
tasks implement.

Authorities: [PLAN.md](../PLAN.md) §11 for scope,
[RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md)
Phase 6, §5.3 (cost-model versioning) and §5.4 (lookahead) for research
behaviour, [ARCHITECTURE_DECISION.md](../architecture/ARCHITECTURE_DECISION.md)
§10.1 (the R&D collections) and §20.2 (lot sizing).

---

## 1. Goal

> Determine how the same market pattern behaves across different strategies.
> Evaluate occurrence count, entries, exits, win/loss, expectancy, drawdown,
> costs, slippage and market regime.
>
> **Done when** research can answer: "When this pattern occurred, how did each
> strategy behave?"

Phase 4 made a strategy's outcome reproducible over stored bars; Phase 5 named
the market conditions in those bars. Phase 6 joins them — every eligible
strategy replayed over the same market, whether or not it ever traded live,
and each of its decisions read against the patterns that preceded it.

It is not Phase 7. This phase produces the matrix and shows every sample size;
whether a cell is evidence or noise is the statistical gate's question.

---

## 2. What exists

### 2.1 The most important finding — nothing to port

Unlike Phases 4 and 5, no branch carries counterfactual code (`git grep`
across `main`, `docs/architecture-baseline`, `wip/phase-3-staged`). Phase 6 is
built here, on two finished foundations:

| Foundation                      | Gives Phase 6                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `runHistoricalReplay` (Phase 4) | One strategy over stored bars: a manifest with every model version, a fingerprint, and a record |
| `sweepPatterns` (Phase 5)       | Versioned, provenance-stamped observations over the same bars                                   |

### 2.2 What is missing between them

1. **The replay record is a summary, not the trail.** Its `TradeRow` has no
   entry or exit time, no slippage and no entry-bar timestamp; its signals
   have no time at all. A join on "the bar the pattern completed" has nothing
   to join. The pipeline holds the complete core `Trade`s and `Signal`s — they
   are simply not handed out.
2. **Most of the library cannot be replayed yet.** Of the eight registered
   strategies, only `EMA_CROSSOVER`, `RSI` and `ORB` trade the analysed
   instrument. The five index-option strategies trade option contracts, whose
   prices the dataset does not hold (Phase 4 R3); two of them also need chain
   history (spec §5.8). The spec says to exclude them rather than evaluate
   them against an absent market.
3. **There is no research regime.** The one regime-like value in the system,
   the market view, combines index trend with breadth — and with no breadth
   symbols it is always `NEUTRAL`. Its index read also confirms trend with VWAP
   computed from index volume, which is `SUSPECT` on every stored bar (Phase 5
   D3). See §5, finding F1.
4. **No home for the result.** ADR §10.1 lists the R&D collections; none is a
   counterfactual collection.

---

## 3. Design decisions

### D1 — Every strategy is accounted for

Every registered strategy appears in every run: evaluated, or excluded with
the reason — "trades an option contract; the dataset holds no contract prices",
"needs an option chain; none is recorded". The exclusion uses the same rule as
the replay's refusal, so the two cannot disagree. A table that silently lists
three strategies reads as "the library is three strategies".

### D2 — Each strategy alone, on each symbol alone

A strategy is replayed separately per symbol with the same capital and limits.
Running them together measures the shared capital and risk engine, not the
strategies (spec Phase 6). Sizing stays in: a strategy right about direction
that cannot size a position did not trade, and the counterfactual says so
(spec, ADR §20.2).

### D3 — The replay hands out its trail, without changing its record

`runHistoricalReplay` also returns the run's complete core `Signal`s, risk
decisions and `Trade`s. The record, and therefore every Phase 4 fingerprint,
is unchanged — the trail sits beside it, not inside it.

### D4 — Regime is the index trend, versioned, and volume-free

`REGIME_MODEL_VERSION` "1": the regime index's close against its EMA(21),
folded continuously across sessions from bars ≤ t — `BULLISH` above, `BEARISH`
below, `NEUTRAL` while the EMA is not yet warm. It is the trend half of the
system's own market view, without the VWAP confirmation the stored index
volume cannot support. One regime index (by default `NSE:NIFTY50-INDEX`)
labels every symbol, because a regime describes the market, not the
instrument. Pinned like the detectors.

**Settled in 6.3.** `apps/api/src/counterfactual/regime.ts`. The EMA is the
shared indicator fold (SMA-seeded), not the market view's private one (seeded
with the first close): the rule is the view's, the arithmetic is the one every
indicator uses. A symbol's bar takes the latest regime-index label at or
before it, never a later one. Proven over every prefix of a three-session
series; pinned to `{version, counts, sha256}`; three mutants killed — a label
read one bar ahead, a changed period, volume creeping in. A fourth (trusting
an unwarmed EMA) is equivalent: the fold reads nothing until it is seeded.

### D5 — Attribution is declared, versioned, and only looks forward to the decision

`ATTRIBUTION_MODEL_VERSION` "1". For an occurrence of pattern P on symbol X at
bar t, strategy S on X is, exactly one of:

| Relation    | Meaning                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| `ENTERED`   | S opened a Trade whose entry decision bar is in `[t, t + w bars]`, same session |
| `SIGNALLED` | S proposed an entry in that window, but no Trade opened — risk refused it       |
| `HOLDING`   | S already held a Trade open at t                                                |
| `FLAT`      | none of these: S did not act on it                                              |

`w` defaults to 0 — the strategy decided on the bar the pattern completed —
and is recorded on every run. The labels (pattern, regime) use only bars ≤ t;
the outcome is necessarily later, and comes from the strategy's own replay,
which Phase 4 proved lookahead-free.

### D6 — The matrix shows every sample size

One row per `(pattern, strategy)` and per `(pattern, strategy, regime)`, and a
`(ALL, strategy)` baseline — what the strategy did regardless of pattern —
because a conditional rate means nothing without the unconditional one. Each
row: occurrences, `ENTERED` / `SIGNALLED` / `HOLDING` / `FLAT` counts, Trades,
exits by reason, wins, losses, win rate, gross, charges, slippage, net,
expectancy (net per Trade) and per unit held, maximum drawdown of the
cumulative net in time order, and mean holding minutes. `n` is on every row.
A Trade is counted once per row, however many occurrences point at it.

### D7 — A run is reproducible and kept in `strategy_experiments`

A run's manifest names the dataset, every strategy (version, or exclusion
reason), every detector version, and every model — position sizing, exit,
slippage, transaction cost (spec §5.3), regime and attribution — and its
matrix is fingerprinted. It is kept in `strategy_experiments`, an R&D
collection ADR §10.1 already lists, with `kind: "COUNTERFACTUAL"`, rather than
a new collection for the same concept. Research database only; it reads
`candles` and writes nothing else.

---

## 4. Proposed task order

| ID  | Task                                                                                                                        | Depends on |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 6.1 | The replay returns its trail — complete Signals, risk decisions and Trades — with its record and fingerprint unchanged (D3) | —          |
| 6.2 | Eligibility: every registered strategy evaluated or excluded with its reason (D1)                                           | —          |
| 6.3 | The regime label: index trend, versioned, volume-free, pinned, lookahead-proven (D4)                                        | —          |
| 6.4 | Attribution and the matrix — relations, metrics, baseline, sample sizes (D5, D6)                                            | 6.1, 6.3   |
| 6.5 | The counterfactual run: each strategy alone per symbol, manifest and fingerprint, deterministic (D2, D7)                    | 6.2, 6.4   |
| 6.6 | Kept in `strategy_experiments`, research database only; operator CLI (D7)                                                   | 6.5        |
| 6.7 | Acceptance: the real year twice — identical fingerprints, and the question answered                                         | 6.6        |

---

## 5. Findings outside this phase

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Owner        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| F1  | The live market view confirms each index's trend with VWAP computed from the index's own volume — `SUSPECT` on every stored bar. Live risk acts on it; ADR §20.6 says such volume supports no conclusion. Changing it changes the risk gate and the golden record, so it is recorded here, not changed.                                                                                                                                                                                                                                                                                                                                                                                                           | trading core |
| F2  | **A strategy that declares no indicators never runs on its own.** The Indicator Engine publishes `INDICATORS_UPDATED` only for a series with an indicator registered (`packages/engines/src/indicators/indicator-engine.ts:144`), and the Strategy Runner acts only on that event. `ORB` at its defaults declares none, so it is consulted only when some other strategy registers an indicator on the same symbol. Replayed alone over a real NIFTY month it produced no signal of any kind, not even a HOLD, while `ORB_BREAKOUT` occurred 58 times. Live, whether ORB trades depends on which other strategies share its symbol. The golden fixture runs only EMA and RSI, so nothing caught it. Found in 6.6. | trading core |

---

## 6. Done when

The stored NIFTY and BANKNIFTY year, every registered strategy evaluated or
excluded with its reason, swept against the five detectors twice: identical
fingerprints, and for every pattern a row per strategy saying how often it
entered, signalled, held or stood aside, and what the Trades it entered
earned — with the sample size on every row.

---

## Related documents

- [../PLAN.md](../PLAN.md) §11
- [../architecture/RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md) Phase 6, §5.3, §5.4
- [PHASE_4_DETERMINISTIC_REPLAY.md](PHASE_4_DETERMINISTIC_REPLAY.md) — the replay and its limits R1–R4
- [PHASE_5_PATTERN_VOCABULARY.md](PHASE_5_PATTERN_VOCABULARY.md) — the vocabulary and its limits P1–P4
