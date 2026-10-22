# Phase 8 — Daily research

**Status: see [PLAN.md](../PLAN.md) §13.** Phase 8 is open; its task board
lives there and nowhere else. This document holds the decisions the board's
tasks implement.

Authorities: [PLAN.md](../PLAN.md) §13 for scope,
[RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md)
Phase 8, §5.4 (lookahead), §5.5 (trading calendar), §5.8 (data revision),
§6.1–6.3 (records) and §7 (chart specifications) for research behaviour;
[ARCHITECTURE_DECISION.md](../architecture/ARCHITECTURE_DECISION.md) §10.1
and §18 (R&D failure is not a trading failure).

---

## 1. Goal

> Automatically analyse each completed trading day: load candles, compute
> features, detect patterns, find strategy signals, find trades, link entry
> to exit, analyse outcome, store evidence. Output: Daily Research Report,
> Pattern Observations, Strategy Observations, Trade Evidence, Chart
> Specifications. **No PNG is the source of truth.**

Phases 5–7 measure a whole window at once. Phase 8 makes the unit of research
one instrument on one trading day — the record Phase 9 aggregates and the
knowledge base (Phase 10) will retrieve — and makes it happen without anyone
asking, every day the market closes.

---

## 2. What exists

### 2.1 Nothing to port

No branch carries daily-research code. Phase 8 is built here, on Phase 6's
counterfactual run (replays, sweep, regime, attribution) and Phase 5's
observations.

### 2.2 What a day needs that a window does not have

1. **A definition of "the day's results" that does not depend on the batch.**
   Sliced out of a year-long run, a day's Trades depend on where that run
   began: strategy state, warm-up and the capital it had already spent. A
   report must be the same however, and whenever, it is produced.
2. **Evidence per Trade**, not per cell: the candles from entry to exit, and
   what came before the entry.
3. **A record of what it stood on** — so that when a bar is revised, the
   reports that read it can be found (spec §5.8).
4. **A home and a trigger.** `research_reports` is the ADR's collection, one
   for every period with a `period` field (spec §6.1). Nothing runs research
   on its own today.

---

## 3. Design decisions

### D1 — A day is a fixed run ending on it

`DAILY_RESEARCH_VERSION` 1: the report for instrument X on day D is the
counterfactual run over the **K trading sessions ending at D** (K = 5),
reporting D alone. The K − 1 earlier sessions are warm-up — indicators, the
regime's EMA, strategy state — and nothing from them is reported. Bars after
D are never read (§5.4), and the report is a function of D, X and its
declared models only: produced tonight or re-produced next year, it is the
same report. K is on the manifest.

### D2 — Trade evidence: entry to exit, and what came before

For every Trade entered on D: the Signal and bar that opened it and the
order that closed it; why it ended; gross, charges, slippage, net; the bars
it was held and its **maximum favourable and adverse excursion** measured on
the bars from entry to exit; and **what preceded it** — the regime at its
entry bar and the pattern occurrences in the N bars before entry (N = 6,
half an hour) and on its entry bar. "Conditions preceding profits and
losses" (spec Phase 8) is these, recorded per Trade, so Phase 9 can count
them.

### D3 — Observations: the day, its patterns, each strategy

**Day features**: open, high, low, close, range, return, gap from the prior
session's close, realised volatility of 5-minute returns, bars, special
session or not, regime at the close, and the bars' sources, ingestion
versions and volume quality. **Pattern observations**: every occurrence on D
with its market context, and — the spec's "compare one pattern across
multiple strategies" — each strategy's relation to it (Phase 6 D5).
**Strategy observations**: per strategy, its actionable signals that day,
approved and blocked by check, the Trades it entered, and its net — or its
exclusion and the reason.

### D4 — Chart specifications, never images

Spec §7. A chart is `symbol · interval · start · end`, overlays, markers and
annotations — one for the day (every pattern, entry and exit marked) and one
per Trade (entry to exit, padded). Overlays are the strategy's own indicators;
a volume-derived overlay (VWAP) is **omitted and annotated** on a day whose
volume is not `REAL` (Phase 5 D3). Rendering is a client's job; the
specification is the evidence.

### D5 — A report says what it stood on, and is never edited

Every report carries its inputs: the bars read (count per symbol, first and
last) and a sha256 of them (ts, OHLCV, source, ingestion version). A report
whose inputs no longer match the stored bars is **stale** (spec §5.8:
invalidate → recompute → new research version). Regenerating it writes
version 2 beside version 1; nothing is edited. Kept in `research_reports`,
`period: "DAY"`, one document per (day, instrument, version), research
database only.

### D6 — It runs itself, outside the trading runtime

One idempotent operation — analyse every **completed** trading day not yet
reported (and, asked to, every stale one) — exposed as a CLI a scheduler
calls after the nightly backfill. Not a job inside the trading runtime: R&D
failure must not become trading failure (ADR §18), and the R&D service that
would host it does not exist yet. "Completed" means its session has closed and
its bars are stored; a day with no bars is a closed market, not a gap.

---

## 4. Proposed task order

| ID  | Task                                                                                                           | Depends on |
| --- | -------------------------------------------------------------------------------------------------------------- | ---------- |
| 8.1 | The day's run: K sessions ending at D, reporting D alone; independent of later bars and of the batch (D1)      | —          |
| 8.2 | Trade evidence: entry to exit, excursions, what preceded the entry (D2)                                        | 8.1        |
| 8.3 | Observations: day features, patterns compared across strategies, each strategy's day (D3)                      | 8.1        |
| 8.4 | Chart specifications for the day and each Trade; volume overlays only on real volume (D4)                      | 8.2, 8.3   |
| 8.5 | The report: inputs fingerprinted, versioned, kept in `research_reports`; staleness (D5)                        | 8.4        |
| 8.6 | Every completed, unreported day, automatically and idempotently; CLI (D6)                                      | 8.5        |
| 8.7 | Acceptance: the real year reported; a re-run adds nothing; a revised bar is caught and recomputed as version 2 | 8.6        |

---

## 5. Done when

Every trading day of the stored year has a report per instrument — features,
patterns compared across strategies, each strategy's day, evidence for every
Trade, chart specifications — produced by one command that adds nothing when
run again; each report is reproducible from its day alone; and a revised bar
marks exactly the reports that read it stale, and recomputing them writes new
versions beside the old.

---

## 6. Acceptance (task 8.7)

The real year's NIFTY and BANKNIFTY bars (36,926), copied to a scratch
database — the research database stays read-only — and researched through
`scripts/daily-research.mts` at `11f9b1a`, K = 5, every strategy at its
defaults, ₹10,00,000 and the default limits:

| Run                                                                                    |                           Reported | Recomputed | Current | Took |
| -------------------------------------------------------------------------------------- | ---------------------------------: | ---------: | ------: | ---: |
| 1 — the year                                                                           | **494** (247 days × 2 instruments) |          0 |       0 | 57 s |
| 2 — again                                                                              |                                  0 |          0 |     494 | 18 s |
| — one NIFTY bar revised: 2026-03-02 10:55 IST, close × 1.0001, ingestion version 999 — |                                    |            |         |      |
| 3 — with `--recompute-stale`                                                           |                                  0 |     **10** |     484 | 20 s |
| 4 — again                                                                              |                                  0 |          0 |     494 |    — |

- **Exactly the reports that read the bar:** 2026-03-02, 03-04, 03-05, 03-06
  and 03-09 — the revised day and the four sessions after it, Holi
  (03-03) having none — for _both_ instruments, because every report reads
  the whole market. Each as version 2, version 1 kept beside it.
- **In the 494:** 1,940 Trade evidence items, 4,362 pattern observations
  each compared across the three evaluated strategies, 2,434 chart
  specifications; VWAP omitted, and said to be, on all 494 day charts — the
  index year's volume is `SUSPECT`.
- **Reproducible from its day alone:** the stored 2026-06-15 BANKNIFTY
  report, regenerated from `neelkanth_research` over a different loaded
  range (2026-05-01 .. 06-30), has the same fingerprint (`5a93e5f5a868…`).
- `pnpm test:integration`, strict: 1,345 tests, 0 skipped.

One report, as research reads it — NIFTY50, 2026-03-02 (v2): opened 2.1%
below the prior close, closed +0.77% in a `BULLISH` regime; EMA_CROSSOVER
one Trade (+140), RSI two (−958), ORB two (−1,940); the first ORB_BREAKOUT
of the day ENTERED by ORB and FLAT for the other two; ORB's Trade, entered
on that breakout in a then-`BEARISH` regime, held 24 bars, at best +2.3
and at worst −189.6 per unit, closed for a loss.

**Still standing:**

| #   | Limit                                                                                                                                                                   | Owner             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| L1  | Nothing schedules it: the CLI is ready for a scheduler, and no R&D service exists yet to host one (ADR §18 keeps it out of the trading runtime).                        | R&D runtime       |
| L2  | A report reads the whole market, so a revision on one instrument recomputes every instrument's reports for those sessions — correct, and wide.                          | by design         |
| L3  | Five sessions of warm-up converge the default indicators but not slower ones; the dataset's first days have fewer sessions, and say so in `sessions`.                   | by design         |
| L4  | Charts are specifications only; no renderer exists.                                                                                                                     | dashboard         |
| L5  | VWAP and the two volume detectors say nothing on the index year (`SUSPECT` volume).                                                                                     | data (Phase 1 Q4) |
| L6  | Index P&L in points on a synthetic instrument; three of eight strategies evaluable.                                                                                     | carried           |
| L7  | The scratch MongoDB cluster intermittently resets connections (`ECONNRESET`), failing an integration run that passes on rerun — infrastructure, seen in Phases 6 and 8. | infrastructure    |

## Related documents

- [../PLAN.md](../PLAN.md) §13
- [../architecture/RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md) Phase 8, §5.8, §6, §7
- [PHASE_6_COUNTERFACTUAL_EVALUATION.md](PHASE_6_COUNTERFACTUAL_EVALUATION.md) — the run a day is built from
- [PHASE_7_STATISTICAL_VALIDATION.md](PHASE_7_STATISTICAL_VALIDATION.md) — limit S1, which daily research is the cure for
