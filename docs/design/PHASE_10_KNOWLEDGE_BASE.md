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

## Related documents

- [../PLAN.md](../PLAN.md) §15
- [../architecture/RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md) Phase 10, Phase 11
- [PHASE_8_DAILY_RESEARCH.md](PHASE_8_DAILY_RESEARCH.md), [PHASE_9_PERIODIC_RESEARCH.md](PHASE_9_PERIODIC_RESEARCH.md) — the reports indexed
- [PHASE_7_STATISTICAL_VALIDATION.md](PHASE_7_STATISTICAL_VALIDATION.md) — findings, and the rule that a number never travels without its context
