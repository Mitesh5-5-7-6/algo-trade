# Neelkanth Trader — Documentation

Autonomous algorithmic trading platform for NSE/BSE via FYERS. Paper first, live later, same pipeline.

## The documents

| Document                                                                                 | What it is                                                                                                              | When to read it                                                        |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [PLAN.md](PLAN.md)                                                                       | **The single execution authority** — the current phase, the current task, and what may start                            | **First, before changing any code**                                    |
| [architecture/ARCHITECTURE_DECISION.md](architecture/ARCHITECTURE_DECISION.md)           | The stable architectural authority — what was chosen, why, what was rejected, what is mandatory, what must never happen | Before designing anything that crosses a module or deployment boundary |
| [architecture/RND_RESEARCH_SPECIFICATION.md](architecture/RND_RESEARCH_SPECIFICATION.md) | The Market R&D system: the data→AI chain, sixteen phases, the seven research rules                                      | Before building anything in the research platform                      |
| [architecture/CURRENT_STATE.md](architecture/CURRENT_STATE.md)                           | What the repository actually contains today, and every known gap with its evidence                                      | Before assuming a component exists                                     |

Start with `PLAN.md`: it decides what to build. The other three answer why the system is shaped this way, how R&D must behave, and what already exists — none of them decides order, and none of them carries a phase list.

### Implementation designs

One per phase, written before the code. A design states the decisions an implementation must follow, and names the questions it must not answer by guessing.

| Design                                                                 | Phase                      | Status                  |
| ---------------------------------------------------------------------- | -------------------------- | ----------------------- |
| [design/PHASE_1_HISTORICAL_DATA.md](design/PHASE_1_HISTORICAL_DATA.md) | 1 — Historical market data | Design, not implemented |

---

## How these documents are written

Three rules govern every edit. They are not style preferences — each exists because its absence has already caused a concrete problem here.

### 1. Status tags are mandatory

Every section of both architecture documents carries exactly one tag:

| Tag           | Meaning                                                      |
| ------------- | ------------------------------------------------------------ |
| `DECIDED`     | Settled. Changing it means superseding the document.         |
| `PROPOSED`    | The intended design. Not built. Not binding until promoted.  |
| `DEFERRED`    | Deliberately postponed, with a named trigger for revisiting. |
| `CURRENT GAP` | The repository contradicts the decision today.               |

`CURRENT_STATE.md` uses a separate, component-level vocabulary: `EXISTS`, `PARTIALLY EXISTS`, `BROKEN`, `MISSING`. The two vocabularies are not interchangeable. `BROKEN` is its own category because several components are constructed, wired, covered by tests, and still do not work.

### 2. The tense rule

Never describe unbuilt infrastructure in the present tense, and avoid the vague future tense that quietly becomes the present tense on re-reading.

Not this:

> The system ingests historical 5-minute candles.
> Historical ingestion will be implemented.

This:

> **Phase 1 implementation target:** introduce historical 5-minute market-data ingestion and establish the canonical research candle dataset.

Documentation that describes future infrastructure in the present tense until nobody remembers which parts are real is the specific failure these documents exist to prevent.

### 3. Audit the branch, not a snapshot

Current-state claims are verified against the working branch at the moment of writing. A ZIP export, a stale clone, or a previous conversation is not evidence. This rule exists because `packages/engines/src/exit/` was believed absent from a snapshot while being present and wired in the repository.

---

## The `plan/NN` citation bridge

Commit `c158458` deleted the entire `plan/` directory — 29 markdown files. Roughly **900 `plan/NN §X` citations remain in source comments**, across configuration, the broker contract, the Redis keyspace, the settings repository, `.env.example`, CI and the root package manifest.

Those comments are **not** being rewritten. This table resolves them instead. Where a topic has no home in the current documents, the originals remain recoverable:

```
git show c158458^:plan/14_RISK_ENGINE.md
```

| Deleted document                       | Topic                                | Now covered by                                                                                                                                          |
| -------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan/00_PROJECT_OVERVIEW.md`          | Project overview                     | [ARCHITECTURE_DECISION §1, §3](architecture/ARCHITECTURE_DECISION.md)                                                                                   |
| `plan/02_MASTER_ARCHITECTURE.md`       | Master architecture                  | [ARCHITECTURE_DECISION §3, §7](architecture/ARCHITECTURE_DECISION.md)                                                                                   |
| `plan/03_MONOREPO_STRUCTURE.md`        | Monorepo structure                   | [ARCHITECTURE_DECISION §6](architecture/ARCHITECTURE_DECISION.md)                                                                                       |
| `plan/04_TECH_STACK.md`                | Tech stack                           | Removed — recover from `c158458^`                                                                                                                       |
| `plan/05_BACKEND_ARCHITECTURE.md`      | Backend architecture                 | [ARCHITECTURE_DECISION §7](architecture/ARCHITECTURE_DECISION.md)                                                                                       |
| `plan/06_FRONTEND_ARCHITECTURE.md`     | Frontend architecture                | [ARCHITECTURE_DECISION §17](architecture/ARCHITECTURE_DECISION.md)                                                                                      |
| `plan/07_DATABASE_DESIGN.md`           | Database design, collections, TTLs   | [ARCHITECTURE_DECISION §10.1](architecture/ARCHITECTURE_DECISION.md)                                                                                    |
| `plan/08_REDIS_ARCHITECTURE.md`        | Redis architecture, keyspace         | [ARCHITECTURE_DECISION §10.2](architecture/ARCHITECTURE_DECISION.md)                                                                                    |
| `plan/09_EVENT_DRIVEN_SYSTEM.md`       | Event-driven system                  | [ARCHITECTURE_DECISION §7, §11](architecture/ARCHITECTURE_DECISION.md)                                                                                  |
| `plan/10_WEBSOCKET_SYSTEM.md`          | WebSocket / realtime UI              | [ARCHITECTURE_DECISION §17](architecture/ARCHITECTURE_DECISION.md)                                                                                      |
| `plan/11_PAPER_TRADING_ENGINE.md`      | Paper trading engine                 | [ARCHITECTURE_DECISION §8](architecture/ARCHITECTURE_DECISION.md)                                                                                       |
| `plan/12_ORDER_ENGINE.md`              | Order engine, idempotency, lifecycle | [ARCHITECTURE_DECISION §9.1](architecture/ARCHITECTURE_DECISION.md)                                                                                     |
| `plan/13_POSITION_ENGINE.md`           | Position engine                      | [ARCHITECTURE_DECISION §7](architecture/ARCHITECTURE_DECISION.md)                                                                                       |
| `plan/14_RISK_ENGINE.md`               | Risk engine, sizing, limits          | [ARCHITECTURE_DECISION §7, §20.1](architecture/ARCHITECTURE_DECISION.md)                                                                                |
| `plan/15_STRATEGY_ENGINE.md`           | Strategy engine, signal contract     | [ARCHITECTURE_DECISION §7, §5.2](architecture/ARCHITECTURE_DECISION.md)                                                                                 |
| `plan/16_STRATEGY_LIBRARY.md`          | Strategy library                     | [CURRENT_STATE §4.4](architecture/CURRENT_STATE.md)                                                                                                     |
| `plan/17_MARKET_DATA_ENGINE.md`        | Market data, candles, sessions       | [ARCHITECTURE_DECISION §7](architecture/ARCHITECTURE_DECISION.md) · [RND_RESEARCH_SPECIFICATION §4 Phase 1](architecture/RND_RESEARCH_SPECIFICATION.md) |
| `plan/18_INDICATOR_ENGINE.md`          | Indicator engine                     | [ARCHITECTURE_DECISION §7](architecture/ARCHITECTURE_DECISION.md)                                                                                       |
| `plan/19_BROKER_INTEGRATION.md`        | Broker integration, FYERS            | [ARCHITECTURE_DECISION §13.1, §15](architecture/ARCHITECTURE_DECISION.md)                                                                               |
| `plan/20_AI_ENGINE.md`                 | AI engine                            | [RND_RESEARCH_SPECIFICATION §9](architecture/RND_RESEARCH_SPECIFICATION.md)                                                                             |
| `plan/21_AUTHENTICATION.md`            | Authentication, sessions, step-up    | Removed — recover from `c158458^`                                                                                                                       |
| `plan/22_DEPLOYMENT.md`                | Deployment                           | [ARCHITECTURE_DECISION §8, §14](architecture/ARCHITECTURE_DECISION.md)                                                                                  |
| `plan/23_MONITORING.md`                | Monitoring, health, readiness        | [ARCHITECTURE_DECISION §19](architecture/ARCHITECTURE_DECISION.md)                                                                                      |
| `plan/24_SECURITY.md`                  | Security                             | [ARCHITECTURE_DECISION §13](architecture/ARCHITECTURE_DECISION.md)                                                                                      |
| `plan/25_CODING_STANDARDS.md`          | Coding standards                     | Removed — recover from `c158458^`                                                                                                                       |
| `plan/26_AI_ASSISTANT_RULES.md`        | AI assistant rules                   | Removed — recover from `c158458^`                                                                                                                       |
| `plan/27_TESTING.md`                   | Testing strategy                     | Removed — recover from `c158458^`                                                                                                                       |
| `plan/28_ROADMAP.md`                   | Roadmap                              | [RND_RESEARCH_SPECIFICATION §4](architecture/RND_RESEARCH_SPECIFICATION.md)                                                                             |
| `plan/MASTER_PROJECT_SPECIFICATION.md` | Master specification                 | [ARCHITECTURE_DECISION](architecture/ARCHITECTURE_DECISION.md) (whole document)                                                                         |

There was never a `plan/01`.

The five "removed" rows are deliberate: authentication, coding standards, testing strategy, tech stack and AI assistant rules are operational documentation rather than architectural decisions. They are recoverable from history and can be reinstated under `docs/` if they earn their place.

---

## Other repository documents

| File              | What it is                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ImproveRedis.md` | Live work order on Redis command consumption. Still valid.                                                                                                                                 |
| `task.md`         | Phase tracker derived from the deleted `plan/28_ROADMAP.md`. Partly orphaned; superseded for research work by [RND_RESEARCH_SPECIFICATION §4](architecture/RND_RESEARCH_SPECIFICATION.md). |
