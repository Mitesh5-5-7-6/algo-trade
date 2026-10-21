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

### 2.3 Audit outcome (task 5.1)

Ported as written, with what had moved under it:

| Point              | Outcome                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — calendar       | `sessionOpenTsFor` is calendar arithmetic, so it now lives in `core` beside `startOfDayIST`; the sweep reads `istDateKey`, `sessionOpenTsFor` and `intervalMs` (which had moved too) from `core`. A Budget Sunday is swept as its own session, anchored to its own open — the sweep groups by IST date and never asks the weekday rule, so special sessions needed no code, only a test. |
| 2 — canonical JSON | The params key is `core`'s `canonicalJson`; the private copy is gone. The two agreed on plain data and differed only on values parameters never hold. Pinned: the key must equal `canonicalJson(params)`, and a plain `JSON.stringify` fails three tests.                                                                                                                                |
| Store test         | The repository's Mongo test predates the probe convention — without Mongo it failed rather than skipped, and never cleared between tests. It now probes, skips visibly, and runs strict (11/11).                                                                                                                                                                                         |

Points 3–5 are tasks 5.2 and 5.3. Nothing else needed changing: the five
detectors, the registry, the sweep's warm-up and session-anchoring rules, the
runner and the six-field identity pass their baseline tests unmodified.

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

**Settled in 5.2, wider than first written.** VWAP is volume-weighted over the
session, so a VWAP reclaim is a volume-based conclusion too: `VWAP_RECLAIM`
declines when any bar since the open is untrusted. The ADR sentence covers
both; naming only one would have been the board's wording, not the rule.

How: a detector declares the bars its answer rests on (`volumeBars`), and the
registry declines when any fails `hasTrustedVolume` (`core`; only `REAL`, with
absent fields meaning `REAL`). The check lives in one place, so no detector can
forget it and no caller using the registry can skip it. The sweep reports
declines per detector as `declinedForVolume`, beside `skippedForWarmup`:
"found nothing" and "could not look" stay different facts.

**What it means on the real dataset.** Every stored bar — 18,463 each for
`NSE:NIFTY50-INDEX` and `NSE:NIFTYBANK-INDEX`, 2025-09-29 to 2026-09-28 — is
`SUSPECT`, by Phase 1's rule that an index's aggregate volume is unverified.
So on that year `HIGH_VOLUME_BREAKOUT` and `VWAP_RECLAIM` decline every warm
bar, and only the three price-only detectors produce observations. That is the
ADR working, not a gap. Promoting index volume to `REAL` is a data decision
(Phase 1 Q4), not something a detector may assume.

Both detectors stay `1.0.0`: no observation was ever stored under the baseline
rule, so there is nothing for the version to tell apart.

### D4 — An observation says what it stood on

Every observation carries `dataProvenance` (the bar's key, source and
ingestion version) and `marketContext` (its volume flags), reusing the Trade's
Phase 2 shapes. A pattern observed on a `LIVE_TICK` bar later overwritten by
the broker's record must still say which bar it saw.

**Settled in 5.3.** Both are required on every occurrence and observation, and
the schema refuses provenance that names a bar other than the occurrence's own
`(symbol, interval, ts)`. The reading of a bar is one pair of functions in
`core` — `provenanceOf` and `marketContextOf` — which the strategy runner now
uses for the Trade as well, so a pattern and a trade on the same bar cannot
describe it differently.

### D5 — A detector's version means its arithmetic

Spec §5.1: if a definition changes, research produced under the old one stays
reproducible and correctly labelled. So, as Phase 4 did for its models, each
detector's version is pinned to its outputs over a fixed bar series: change
what it detects without bumping `detectorVersion` and the pin fails. And the
definitions are catalogued — one `patterns` document per `(patternId,
detectorVersion)` with its definition text and parameter defaults — so an old
observation can still be read against the definition that produced it after
the code has moved on.

**Settled in 5.4.** The pin sweeps each detector at its defaults over one fixed
three-session series — integer arithmetic only, so it is bit-identical on every
runtime — and pins `{version, count, sha256 of what it found}`. Every
detector fires on it (5 to 22 times), and the volume ladder spans the 1.5×
threshold. Five mutants killed: ORB back to a state, and a nudged default in
each of the other four. Its limit is its series: a change that alters nothing
on it passes, so the series is built to sit on each detector's boundaries.

`patterns` holds a `PatternDefinition` per version — definition text,
`defaultParams`, `volumeBased` — written once. Registering a version whose
rule differs from the catalogued one is reported as a conflict and never
overwrites it; 5.6's sweep refuses to record observations under a conflict.

The version rule this implies: **1.0.0 means the rule as pinned at 5.4.**
Changes before that — D3's volume refusal, D8 — were ports, made before any
observation existed for them to mislabel.

### D6 — Research database only, and read-only to trading

Observations and the catalogue live in `neelkanth_research` (ADR §10.1 lists
`patterns` and `pattern_observations` among the R&D collections). A sweep reads
`candles` and writes those two; it can reach no trading collection.

### D7 — Only the past, proven

A detection at bar `t` sees bars `≤ t`. Proven behaviourally, as Phase 4 did:
appending later bars — different ones, since copies hide leaks — changes no
earlier observation.

### D8 — A pattern is an event, not a state

Settled in 5.4, before the pin fixed what 1.0.0 means. As ported,
`ORB_BREAKOUT` fired on every bar that closed outside the opening range — on
the pin series, 168 times in three sessions. That is a state ("price is above
the range"), and counted per bar it makes one breakout into twelve
observations, inflating exactly the sample Phase 6 divides by. The other four
detectors already report inversions — a cross, a re-cross, a reclaim, a break
of a prior high. `ORB_BREAKOUT` now agrees: it fires on the close that
crosses out of the range, the previous bar having closed at or inside the
level; a return inside and a second break is a second event. The spec names
the pattern but not its rule, so this is a detector decision, not a document
conflict.

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
