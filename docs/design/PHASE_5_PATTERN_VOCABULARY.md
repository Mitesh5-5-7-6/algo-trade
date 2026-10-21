# Phase 5 — Pattern vocabulary

**Status: see [PLAN.md](../PLAN.md) §10.** Phase 5 is open; its task board
lives there and nowhere else. This document holds the decisions the board's
tasks implement.

Authorities: [PLAN.md](../PLAN.md) §10 for scope,
[RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md)
Phase 5 and §5.1 for research behaviour,
[ARCHITECTURE_DECISION.md](../architecture/ARCHITECTURE_DECISION.md) §10.1
(the R&D collections) and §20.6 (volume quality).

---

## 1. Goal

> A small deterministic, versioned pattern library. Each observation includes
> `patternId`, `detectorVersion`, timestamp, symbol, timeframe, market context
> and data provenance. Patterns are calculated only from information available
> at that time. No ML clustering.

A pattern is the first term of `Pattern → Strategy → Outcome`. Phases 2–4 made
the outcome recordable, guaranteed and reproducible; Phase 5 names the market
condition it happened in. Phase 6 then asks how each strategy behaved under
each pattern — and that question is only as honest as the vocabulary.

---

## 2. What exists

### 2.1 The most important finding — the library is already written

Branch `docs/architecture-baseline` carries it inside `ed71384` (the same
commit Phase 4 ported its harness from):

| Piece                                                | What it holds                                                                                                                                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/patterns`                                  | The detector contract, a registry, and the spec's five starting detectors — EMA cross, ORB breakout, RSI reversion, VWAP reclaim, volume breakout — with tests |
| `packages/core/src/pattern.ts`                       | `PatternOccurrence` / `PatternObservation` and a canonical params key                                                                                          |
| `packages/engines/src/patterns/`                     | `sweepPatterns` over a candle series, and a runner reading candles and recording observations                                                                  |
| `packages/db/src/pattern-observations-repository.ts` | `pattern_observations`, idempotent on a six-field identity, with a Mongo integration test                                                                      |

Nothing wires patterns into the live trading runtime — `ed71384`'s runtime and
route changes are Phase 2 Trade work, already ported. Detection is a research
sweep over stored bars, which is where it belongs: R&D failure must not become
a trading failure (ADR §18).

**The honest move is to port it** — the 2.1 and 4.1 precedent.

### 2.2 What the audit must check

It predates Phases 1–4:

1. **The calendar moved to `core`** (Phase 1). The sweep imports `istDateKey`
   from the engines package and `sessionOpenTsFor`, which exists only on the
   baseline branch.
2. **`canonicalJson` now lives in `core`** (Phase 4). The params key carries its
   own copy, which can drift from the one strategy versions and replay
   fingerprints use.
3. **Volume quality** (Phase 1). The volume detector declines only when average
   volume is zero; it never reads `volumeAvailable` or `volumeQuality`.
4. **Observations carry neither market context nor data provenance**, both of
   which PLAN.md §10 requires — and Phase 2 already built both shapes for the
   Trade (`EntryMarketContextSchema`, `DataProvenanceSchema`).
5. **The volume detector is named `VOLUME_BREAKOUT`**; the spec and PLAN.md
   name it `HIGH_VOLUME_BREAKOUT`.

---

## 3. Design decisions

### D1 — The starting set is the spec's five

`ORB_BREAKOUT`, `EMA_CROSS`, `RSI_REVERSION`, `VWAP_RECLAIM`,
`HIGH_VOLUME_BREAKOUT` (spec Phase 5, `DECIDED`). PLAN.md §10's longer list
says the initial set _may_ include `BREAKOUT`, `REJECTION`, `REVERSAL`,
`CONSOLIDATION`, `TREND`, `GAP` and `RANGE`; those are not this phase. A small
vocabulary that is right beats a large one nobody has checked.

### D2 — The spec's names win

The volume detector becomes `HIGH_VOLUME_BREAKOUT`. On research behaviour the
spec is the authority, and no observation has ever been stored, so renaming
costs nothing now and would cost a migration later.

### D3 — No volume conclusion from untrustworthy volume

ADR §20.6: where reliable volume is unavailable, volume-based conclusions are
not drawn. `HIGH_VOLUME_BREAKOUT` declines any bar — the one judged, or one in
its average — whose volume is unavailable, `SUSPECT` or `UNAVAILABLE`. A
detector that read a filler zero as "low volume" would manufacture breakouts.

### D4 — An observation says what it stood on

Every observation carries `dataProvenance` (the bar's key, source and
ingestion version) and `marketContext` (its volume flags), reusing the Trade's
Phase 2 shapes. A pattern observed on a `LIVE_TICK` bar later overwritten by
the broker's record must still say which bar it saw.

### D5 — A detector's version means its arithmetic

Spec §5.1: if a definition changes, research produced under the old one stays
reproducible and correctly labelled. So, as Phase 4 did for its models, each
detector's version is pinned to its outputs over a fixed bar series: change
what it detects without bumping `detectorVersion` and the pin fails. And the
definitions are catalogued — one `patterns` document per `(patternId,
detectorVersion)` with its definition text and parameter defaults — so an old
observation can still be read against the definition that produced it after
the code has moved on.

### D6 — Research database only, and read-only to trading

Observations and the catalogue live in `neelkanth_research` (ADR §10.1 lists
`patterns` and `pattern_observations` among the R&D collections). A sweep reads
`candles` and writes those two; it can reach no trading collection.

### D7 — Only the past, proven

A detection at bar `t` sees bars `≤ t`. Proven behaviourally, as Phase 4 did:
appending later bars — different ones, since copies hide leaks — changes no
earlier observation.

---

## 4. Proposed task order

| ID  | Task                                                                                                   | Depends on |
| --- | ------------------------------------------------------------------------------------------------------ | ---------- |
| 5.1 | Port `ed71384`'s pattern library, sweep and observations store; audit against §2.2 points 1–2          | —          |
| 5.2 | `HIGH_VOLUME_BREAKOUT` — the spec's name, declining untrustworthy volume (D2, D3)                      | 5.1        |
| 5.3 | Observations carry market context and data provenance (D4)                                             | 5.1        |
| 5.4 | Detector versions pinned to their outputs; definitions catalogued in `patterns` (D5)                   | 5.2        |
| 5.5 | Lookahead guard and determinism (D7)                                                                   | 5.1        |
| 5.6 | Operator sweep over the research dataset, research database only (D6)                                  | 5.3, 5.4   |
| 5.7 | Acceptance: sweep the real year twice — identical observations, every one carrying the PLAN §10 fields | 5.6        |

---

## 5. Done when

Sweeping the stored NIFTY and BANKNIFTY year with the five detectors twice
yields identical observations; every observation carries `patternId`,
`detectorVersion`, timestamp, symbol, timeframe, market context and data
provenance; a second recording adds nothing; and each detector's version is
pinned to what it detects.

---

## Related documents

- [../PLAN.md](../PLAN.md) §10
- [../architecture/RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md) Phase 5, §5.1
- [PHASE_2_TRADE_LIFECYCLE.md](PHASE_2_TRADE_LIFECYCLE.md) — the provenance and context shapes
- [PHASE_4_DETERMINISTIC_REPLAY.md](PHASE_4_DETERMINISTIC_REPLAY.md) — the version-pinning and lookahead precedent
