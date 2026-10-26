# Phase 10 — Research knowledge base

**Status: see [PLAN.md](../PLAN.md) §15.** Phase 10 is open; its task board
lives there and nowhere else. This document holds the decisions the board's
tasks implement.

Authorities: [PLAN.md](../PLAN.md) §15 for scope,
[RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md)
Phase 10, Phase 11 (the read models the agent will call), §5.4 (lookahead),
§5.8 (data revision) and §7 (chart specifications);
[ARCHITECTURE_DECISION.md](../architecture/ARCHITECTURE_DECISION.md) §10.1
(`documents`, `embeddings` among the R&D collections).

---

## 1. Goal

> Make accumulated research searchable. Store research reports, patterns,
> pattern observations, strategy experiments, backtests, walk-forward
> results, trade evidence, documents, chart specifications and AI analysis.
> The knowledge base becomes the foundation for the AI agent.

Spec: structured data, documents and chart specifications, searchable —
**pattern retrieval, strategy history, experiment history.** Phase 11's
agent will call these as tools (`findPatterns`, `strategyMatrix`,
`similarSessions`, `tradeHistory`), and every answer it gives must carry the
sample size, date range and cost assumptions behind it. Phase 10 builds those
read models; the agent is not built here.

---

## 2. What exists

### 2.1 Nothing to port

No branch carries knowledge-base code. Phase 10 indexes what Phases 4–9
produce.

### 2.2 What there is to index

| Source                         | Collection                                           | Holds                                                                            |
| ------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| Daily reports (Phase 8)        | `research_reports`, DAY                              | features, patterns across strategies, strategy days, Trade evidence, chart specs |
| Window reports (Phase 9)       | `research_reports`, WEEK / MONTH / QUARTER           | aggregates and answers, coverage                                                 |
| Counterfactual runs (Phase 6)  | `strategy_experiments`, COUNTERFACTUAL               | the matrix                                                                       |
| Hypotheses and tests (Phase 7) | `strategy_experiments`, HYPOTHESIS / HYPOTHESIS_TEST | claims, verdicts, findings                                                       |
| Detector definitions (Phase 5) | `patterns`                                           | every version's rule                                                             |
| Replay runs (Phase 4)          | `replay_runs`                                        | manifests, records                                                               |

**Not yet in existence:** backtests and walk-forward results (Phase 13),
news (N1–N3), AI analysis (Phase 11). Phase 10's document model admits them;
it cannot index what is not there.

### 2.3 The decision taken at opening — no embeddings yet

Semantic search needs an embedding model: an external API (a key, a cost,
research text leaving the machine) or a large local model. **The operator
chose to defer it** (Q1 below). Everything here is deterministic: structured
queries, text search, and similar sessions by numeric day features.

---

## 3. Design decisions

### D1 — One searchable document per research item, derived, never authoritative

A `KnowledgeDocument` in `documents` (ADR §10.1) for each research item —
a day, a window, a Trade, a chart, an experiment, a hypothesis and its
finding, a detector definition. It holds a **kind**, the **facets** it is
queried by (dates, symbols, patterns, strategies, regime, outcome, `n`), a
deterministic **text** rendering, and a **source reference** — collection,
id, version and fingerprint. The source is the evidence; a document is an
index entry over it, rebuilt from it, and never edited by hand.

### D2 — A document says the context of what it says

A rendered text never states a rate without its `n`, period and versions —
the Phase 7 rule (D7) applied to every document. A Trade's text carries its
entry bar, regime, preceding patterns, costs and outcome; a finding's, its
verdict and family.

### D3 — Indexed idempotently; stale when its source moves

The indexer derives every document from the newest version of its source.
A source superseded by a new version (Phase 8 D5, Phase 9 D5) supersedes its
documents: they are rebuilt, the old ones retired with a pointer to the new.
Re-running adds nothing. `KNOWLEDGE_INDEX_VERSION` 1 on every document.

### D4 — Three deterministic ways to search

- **Structured** — by kind, date range, symbol, pattern, strategy, regime,
  outcome, `n`.
- **Text** — a MongoDB text index over the rendered text, ranked by its
  score, ties broken by date then id so results are reproducible.
- **Similar sessions** — each day's numeric features (return, gap, range,
  realised volatility, regime, pattern counts) standardised over the
  indexed sessions and compared by Euclidean distance; the nearest K.

### D5 — Nothing from after "as of"

Every query takes an optional `asOf` date. It returns only research whose
subject ended on or before it — a day's report about that day, a window that
closed — so an agent asking "what looked like this before?" on 2026-03-02
cannot be shown 2026-03-03 (§5.4). Similar sessions standardises only over
sessions up to `asOf`, so even the scale is not borrowed from the future.

### D6 — Read models the agent will call

Pure functions over the documents and their sources, each answer carrying
its `n`, date range and versions: **findPatterns** (where, when, which
regime, what each strategy did), **tradeHistory** (Trade evidence by
strategy, pattern, regime, outcome), **experimentHistory** (counterfactual
runs, hypotheses, tests and findings for a strategy or pattern),
**strategyMatrix** (one pattern against every strategy over a date range,
from the daily reports), and **similarSessions**.

### D7 — Research database only, and run after the research

`documents` lives in the research database; the indexer reads the research
collections and writes `documents` only. One idempotent command for the same
scheduler as Phases 8 and 9.

---

## 4. Open decisions

| #   | Question                                                                                                                    | Decided                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | **Semantic search.** Which embedding model — hosted (key, cost, data leaves) or local (large, slow) — and what is embedded? | **Deferred by the operator at opening.** The document's `text` is what would be embedded; an `embeddings` collection (ADR §10.1) would key vectors by document id, model and model version. Not built. |

---

## 5. Proposed task order

| ID   | Task                                                                                                                                            | Depends on |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 10.1 | The knowledge document: kinds, facets, source reference, context-carrying text (D1, D2)                                                         | —          |
| 10.2 | Rendering every source kind into documents — days, Trades, charts, windows, experiments, hypotheses and findings, detector definitions (D1, D2) | 10.1       |
| 10.3 | The indexer: idempotent, superseded sources re-indexed, `documents` with structured and text indexes (D3, D7)                                   | 10.2       |
| 10.4 | Search: structured and text, `asOf` (D4, D5)                                                                                                    | 10.3       |
| 10.5 | Similar sessions: standardised day features, nearest neighbours, no lookahead (D4, D5)                                                          | 10.3       |
| 10.6 | Read models: findPatterns, tradeHistory, experimentHistory, strategyMatrix — `n`, dates and versions on every answer (D6)                       | 10.4, 10.5 |
| 10.7 | Acceptance: the real year indexed; the spec's questions answered; a re-index adds nothing; a revision re-indexes exactly its documents          | 10.6       |

---

## 6. Done when

The stored year's research — every daily and window report, every Trade,
chart, experiment, hypothesis, finding and detector definition — is indexed
by one idempotent command into `documents`; it can be searched by facet, by
text and by session similarity, never past an `asOf`; the agent's read
models answer pattern retrieval, strategy history and experiment history with
`n`, dates and versions on every answer; and a revised source re-indexes
exactly the documents built from it.

---

## 7. Acceptance (task 10.7)

The research database holds the year's bars and nothing else — no research
has been written to it; every earlier acceptance wrote to a scratch copy. So
the year's bars were copied to a scratch database (the research database
stays read-only) and researched there exactly as the research database would
be: daily research (494 reports, 66 s), periodic research (71 windows under
the published calendar), one counterfactual run over the year, a family of
two hypotheses registered and tested, the detector catalog. Then indexed and
asked through `scripts/knowledge.mts` at `252ec49`.

| Run                                                                               |            Added | Replaced | Unchanged | Removed |
| --------------------------------------------------------------------------------- | ---------------: | -------: | --------: | ------: |
| dry run — nothing written                                                         |            4,949 |        0 |         0 |       0 |
| 1 — the year                                                                      | **4,949**, 5.4 s |        0 |         0 |       0 |
| 2 — again                                                                         |                0 |        0 |     4,949 |       0 |
| — one NIFTY bar on 2026-03-02 revised; 10 daily and 4 window reports recomputed — |                  |          |           |         |
| 3 — after the revision                                                            |                0 |   **96** |     4,853 |       0 |
| 4 — again                                                                         |                0 |        0 |     4,949 |       0 |

By kind: 494 days, 1,940 Trades, 2,434 charts (a day's and each Trade's),
71 windows, 1 counterfactual run, 2 hypotheses, 2 findings, 5 detector
definitions.

- **A revision re-indexes exactly its documents:** the 96 replaced are every
  document built from the 14 recomputed reports, and nothing else — none
  changed that a recomputed report did not build, none such left unchanged.
- **The spec's questions, answered with their context.** _Pattern
  retrieval_ — ORB_BREAKOUT in a BEARISH regime: 811 occurrences over 494
  daily reports, 2025-09-29 .. 2026-09-28, each with what every strategy did
  and how its Trade ended. _Strategy history_ — ORB's Trades after an
  ORB_BREAKOUT: n = 638, 181 wins, net −94,404, −148 a Trade, under the
  slippage and charges models named in the answer. _One pattern against
  every strategy_ — EMA_CROSS: n = 1,470; EMA_CROSSOVER entered on 710,
  ORB on 30, RSI on none; the five derivative and option-chain strategies
  named as excluded, with why. _Experiment history_ — RSI: the year's
  counterfactual run, H-0001 and its finding, SUPPORTED at n = 277 out of
  sample, under gate policy 2. _Similar sessions_ — 2026-03-02 on NIFTY,
  as of that day: a pool of 211 sessions, 2025-09-29 .. 2026-03-02, the
  nearest five.
- **Never past asOf:** week 2026-W10's report is not known on 2026-03-04
  and is on 2026-03-08; similar sessions standardises over the 211 sessions
  up to the day, not the year.
- `pnpm test:integration`, strict: 1,443 tests across 13 packages, 0 skipped, 0 failed.

**Found by the acceptance, and fixed:**

| #   | Finding                                                                                                                                                                                                     | Fix                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | "gap down" found nothing: a day's text gave its gap only as a signed number — and MongoDB's English text index drops "up" and "down" as stop words, so the words alone would not tell the direction either. | A gap is rendered in words, "with a gap down of 1.60% from the prior close" (`KNOWLEDGE_INDEX_VERSION` 2, so every document was re-rendered once); a phrase query, `"gap down"`, keeps the stop words — documented on the query and in the CLI. |
| F2  | The read models' provenance named model versions but not the data version Phase 11 requires on every answer.                                                                                                | `data`: the bar sources and ingestion versions behind the answer — after the revision, the Trades of 2026-03-02 name ingestion version 999, the revised bar's.                                                                                  |

**Still standing:**

| #   | Limit                                                                                                                                                                                            | Owner       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| K1  | The research database holds no research yet: the knowledge base indexes it once the research CLIs are run against it — daily, periodic, counterfactual, hypotheses — then `knowledge.mts index`. | operations  |
| K2  | Similar sessions compares across instruments by default, and NIFTY and BANKNIFTY move together: a day's nearest is often the other index the same day. `--same-symbol` restricts it.             | by design   |
| K3  | Text search is MongoDB's English text index — stemmed, stop words dropped, no synonyms. Embeddings are deferred (Q1).                                                                            | Phase 11    |
| K4  | experimentHistory answers from at most 200 documents (`MAX_RESULTS`) — far above the 5 experiment documents a year produces today.                                                               | later       |
| K5  | Nothing schedules the index (as Phase 8 L1): it is run after the research.                                                                                                                       | R&D runtime |

## Related documents

- [../PLAN.md](../PLAN.md) §15
- [../architecture/RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md) Phase 10, Phase 11
- [PHASE_8_DAILY_RESEARCH.md](PHASE_8_DAILY_RESEARCH.md), [PHASE_9_PERIODIC_RESEARCH.md](PHASE_9_PERIODIC_RESEARCH.md) — the reports indexed
- [PHASE_7_STATISTICAL_VALIDATION.md](PHASE_7_STATISTICAL_VALIDATION.md) — findings, and the rule that a number never travels without its context
