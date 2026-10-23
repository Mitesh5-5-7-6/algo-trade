# Phase 11 — AI research agent

**Status: see [PLAN.md](../PLAN.md) §16.** Phase 11 is open; its task board
lives there and nowhere else. This document holds the decisions the board's
tasks implement.

Authorities: [PLAN.md](../PLAN.md) §16 for scope,
[RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md)
Phase 11 (the tools), §9.2 (RAG is memory, not evidence) and §5.4
(lookahead); [ARCHITECTURE_DECISION.md](../architecture/ARCHITECTURE_DECISION.md)
§5.4 (AI never trades), §13.3 (AI tools never receive production secrets)
and §23 rules 7 and 9.

---

## 1. Goal

> Build an AI that can reason over structured research evidence.

The agent answers a research question by calling the read models Phase 10
built, and every answer it gives carries the **sample size, date range,
strategy version, data version and cost assumptions** behind it (PLAN §16) —
"a claim without those is not an answer, it is a sentence" (spec Phase 11).
It investigates, summarises, compares strategies, finds recurring patterns
and explains findings. It cannot place an order, change a limit, or reach
anything but the research it is asked about.

---

## 2. What exists

### 2.1 Nothing to port

No branch carries agent code; no model SDK is a dependency; no key exists in
any env file.

### 2.2 The tools there are

Phase 10's read models, each answer already a `Provenance` (n, sessions read,
asOf, versions, data version, cost models):

| Tool                 | Read model            | Answers                                                                            |
| -------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| `find_patterns`      | `findPatterns`        | which patterns occurred, when, in which regime, what each strategy did             |
| `strategy_matrix`    | `strategyMatrix`      | one pattern against every strategy, with n and costs                               |
| `trade_history`      | `tradeHistory`        | completed Trades with entry, exit, reason and outcome                              |
| `experiment_history` | `experimentHistory`   | counterfactual runs, hypotheses, tests, findings                                   |
| `similar_sessions`   | `findSimilarSessions` | the sessions most like a day, never from after it                                  |
| `search_research`    | `searchKnowledge`     | the research documents, by facet or text — memory, pointing at the evidence (§9.2) |

### 2.3 The decisions taken at opening

**Q1 — the model: Claude Opus 5.5** (`claude-opus-5-5`), by the operator.
Research text — reports, Trades, findings — is sent to Anthropic's API to be
reasoned over; nothing else is. The key lives in an agent-only env file.

**Q2 — the three tools with nothing behind them are deferred**, by the
operator. PLAN §16 lists `newsContext()`, `runBacktest()` and
`runWalkForward()` among the initial tools, but the news track (N1–N3) is not
built and backtest / walk-forward is Phase 13. They are not exposed — not
stubbed — and the agent is told they do not exist, so it says the evidence is
missing rather than guessing. PLAN §16 is amended to say so.

---

## 3. Design decisions

### D1 — Read-only by construction

The agent's tool surface is the six tools above and nothing else. The agent
module imports the knowledge read models only — never a broker, order, risk,
position or settings module, and never a repository's write method — and a
test fails the build if it does (as Phase 10 D7). `AI → placeOrder()` does
not exist because there is no path to write it (ADR §5.4). There is no
"execute" tool, no shell, no web.

### D2 — Bound to an `asOf`, and bounded in size

Every question is asked **as of** a date (default: today). Every tool call is
answered as of that date: a model that passes a later `asOf`, or a date range
reaching past it, is clamped to it and told so in the result (§5.4). Tool
results are capped — at most 50 rows, the rest counted ("showing 50 of 811")
— while the provenance keeps the full `n`. A tool error returns to the model
as an error result, not a crash.

### D3 — An answer is claims, and every claim cites a tool call

The model finishes by calling `submit_answer`, a strict-schema tool: a
summary and a list of **claims**, each a sentence that cites the ids of the
tool calls it rests on. The **checker**, deterministic, accepts a claim only
if:

- every cited call exists in this session and succeeded;
- every cited result carries a provenance with `n` and a date range;
- every number in the claim's sentence appears in a cited result (to the
  precision written; a percentage may be the result's fraction × 100).

A rejected answer goes back to the model with the reasons, at most twice; an
answer still failing is returned marked **UNSUPPORTED** with the reasons,
never silently. A claim that needs no number ("no tool can answer that") may
cite nothing.

### D4 — The context is attached, not written

The answer the operator reads is rendered by code, not by the model: each
claim followed by the provenance of the calls it cites — `n`, date range,
asOf, strategy and detector versions, data sources and ingestion versions,
slippage and transaction-cost models. The model cannot misstate the sample
size, because it does not state it; the checker only lets it repeat numbers
that are there.

### D5 — No secrets, and the research database only

The agent runs from its own env file (`.env.agent.local`, gitignored):
`ANTHROPIC_API_KEY` and the research `MONGO_URI`, nothing else. It **refuses
to start** when its environment holds a broker or production secret —
`FYERS_*`, `TOKEN_ENCRYPTION_KEY`, `SESSION_SECRET`, `NEELKANTH_OPERATOR_*`,
`REDIS_URL` — so it can never be launched with `.env.local` (ADR §13.3, rules
7 and 9). It reads only `neelkanth_research` or a scratch `neelkanth_it_*` /
`neelkanth_ci_*` database.

### D6 — The model, behind an interface

The loop is written against a small `ResearchModel` interface: one
implementation calls the Anthropic API (`claude-opus-5-5`, adaptive thinking,
effort `high`, streaming, strict tools, server-side refusal fallbacks
`"default"`); the other is a **scripted fake** that replays a fixed sequence
of tool calls and answers. Every test runs on the fake, with no network and
no key. The loop owns its bounds: at most 12 model turns, then the answer is
returned as UNSUPPORTED (budget exhausted). A refusal or a truncated turn is
reported as such, never parsed as an answer.

### D7 — Every answer kept

Each session — question, asOf, model and agent versions, every tool call with
its input and provenance, the answer and the checker's verdict — is kept in
`agent_answers` in the research database, never edited (ADR §10.4). An
answer can be read back, and audited, without calling the model again.

---

## 4. Open decisions

| #   | Question                                                                 | Decided                                                                                                                         |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Which model?                                                             | **Claude Opus 5.5**, by the operator at opening.                                                                                |
| Q2  | `newsContext`, `runBacktest`, `runWalkForward` have nothing behind them. | **Deferred**, by the operator at opening: to the news track and Phase 13.                                                       |
| Q3  | Index the agent's answers into `documents` for later retrieval?          | **Not yet.** An answer is an analysis, not evidence (§9.2); indexing it would let the agent cite itself. Revisit with Phase 12. |

---

## 5. Proposed task order

| ID   | Task                                                                                                                                    | Depends on |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 11.1 | The tool surface: six read-only tools, strict schemas, bound to `asOf`, capped results with provenance; nothing else reachable (D1, D2) | —          |
| 11.2 | The answer contract and its checker: claims citing calls, numbers traceable to results, the rendered context (D3, D4)                   | 11.1       |
| 11.3 | The loop: the model interface, the scripted fake, the Anthropic implementation, bounds, refusals, corrections (D6)                      | 11.2       |
| 11.4 | Keeping every answer: `agent_answers`, never edited (D7)                                                                                | 11.3       |
| 11.5 | The CLI, its own env file, and the secret guard (D5)                                                                                    | 11.4       |
| 11.6 | Acceptance: real questions on the real year, every answer checked, asOf honoured, missing evidence said, a request to trade refused     | 11.5       |

---

## 6. Done when

An operator can ask a research question as of a date and get an answer built
only from the read models, every claim citing the tool calls behind it and
carrying their sample size, date range, strategy and data versions and cost
assumptions; an answer whose numbers are not in the evidence is returned
UNSUPPORTED, never as an answer; the agent has no path to an order, a limit
or a secret; and every answer is kept and can be audited without the model.

---

## Related documents

- [../PLAN.md](../PLAN.md) §16
- [../architecture/RND_RESEARCH_SPECIFICATION.md](../architecture/RND_RESEARCH_SPECIFICATION.md) Phase 11, §9.2
- [PHASE_10_KNOWLEDGE_BASE.md](PHASE_10_KNOWLEDGE_BASE.md) — the read models the tools are
