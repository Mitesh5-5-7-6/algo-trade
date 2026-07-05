# 27 — Testing

> Prerequisites: **[02_MASTER_ARCHITECTURE.md](02_MASTER_ARCHITECTURE.md)** Principle 1 (determinism — the property that makes this chapter possible), **[25_CODING_STANDARDS.md](25_CODING_STANDARDS.md)** §8 (where test requirements enter review), **[22_DEPLOYMENT.md](22_DEPLOYMENT.md)** §2 (the CI gate that enforces them).

---

## 1. Purpose — why testing is different here

Two facts shape everything in this chapter:

1. **Bugs here cost money silently.** A wrong sign in position math, a risk check that passes when it shouldn't, a duplicate fill applied twice — none of these crash. They just quietly produce wrong numbers until real capital notices. Tests are the only mechanism that catches the class of bug this system fears most.
2. **Determinism makes the system *testable* — and tests are what *verify* determinism.** Because the pipeline is deterministic by design (Chapter 02, Principle 1) and strategies are pure functions (Chapter 15 §2), the same inputs must always produce the same decisions. That property is simultaneously the thing that makes golden-run testing (§4) possible and the thing golden-run testing proves. The architecture and the test strategy were designed together; neither works without the other.

---

## 2. The pyramid, mapped to this architecture

| Layer | What it tests | Runs against | Speed |
|---|---|---|---|
| **Unit** | Pure logic: indicator folds, `analyze()`, position math, risk checks | Fabricated inputs, in-memory fakes | ms; every save |
| **Integration** | Engines + real infra: repositories, cache invalidation, event flow | Real Redis + Mongo (ephemeral/test containers) | seconds; every push |
| **Pipeline (golden run)** | The whole machine, end to end | Recorded market data + Paper Broker | seconds–minutes; every push |
| **Dashboard E2E** | Operator workflows | Playwright vs. the real UI + test backend | minutes; every push |

**Why weight sits at the bottom:** the architecture deliberately concentrated its logic in pure functions (Chapter 15 §2, Chapter 18 §7) *so that* the vast majority of correctness can be proven at unit speed. Slow layers exist to test what only they can — wiring, infra behavior, and the whole-machine property — not to re-test logic the unit layer already owns.

---

## 3. What each layer must cover

### Unit (the bulk)
- **Indicators** — every fold in the `indicators` package against known-answer fixtures (hand-computed or reference-verified EMA/RSI/ATR/VWAP series), **seeding rules included** (Chapter 16's SMA-seed vs. Wilder-seed), plus the session-reset behavior for VWAP-class indicators (Chapter 18 §5). *The same fold functions serve live and test by construction (18 §7) — so a passing test is a statement about production math, not a copy of it.*
- **Strategies** — per Chapter 16 §10: every strategy's **trigger cases and its documented traps** (the Weaknesses section is a test plan in disguise: EMA whipsaw sequence, RSI-pinned trend, gap-fill fake, low-volume breakout must all produce the *right non-signal or exit*). Plus: warm-up gating (no signal before `warmupBars`), SL/target present on every entry, `reason` populated, HOLD behavior.
- **Position math** — Chapter 13 §3's formulas: add/reduce/close sequences, average-entry invariance on reduce, realized PnL with charges, long and short signs. This is prime **property-based testing** territory (§7): for any fill sequence, `realized + unrealized` must equal mark-to-market minus cost basis.
- **Risk checks — exhaustive by policy.** Every check (14 §4) in pass and fail; boundary values (loss exactly at limit; size exactly at cap); the **entry/exit asymmetry** (14 §5 — a stop-loss exit approved *while* the daily limit blocks entries); check ordering; **fail-closed** when counters are unreadable (14 §9). *Why "exhaustive by policy" and not "good coverage":* this is the component whose failure mode is silently approving what it exists to block; it gets the standard the kill switch gets.

### Integration
- Repositories against real Mongo (indexes, the unique `signalId` backstop actually rejecting a duplicate — Chapter 12 §6); cache write-then-bust behavior (08 §4); the event relay (emit on Redis → arrives at a subscriber, shaped per `contracts`); **the projection chain**: publish `ORDER_FILLED` → position, portfolio, PnL, and emitted events all correct.
- **Idempotency, explicitly:** deliver the same `ORDER_FILLED` twice → position and PnL byte-identical to once (09 §5, 13 §3). This test is the license for the resync-based recovery design; without it, reconnects are a data-integrity gamble.

### Pipeline — the golden run (§4)

### Dashboard E2E
- The operator's critical paths, driven through the real UI: create-and-enable a strategy → a (test-injected) fill appears in positions → PnL updates live; **the kill switch halts order flow**; disconnect shows stale-state honestly (06 §7). *Why these and not pixel tests:* the dashboard's job is truthful control (Chapter 06 §2, §7); E2E verifies control and truthfulness, not aesthetics.

---

## 4. Golden-run tests — the determinism proof

The signature test of this system:

1. A **recorded market-data fixture** (a captured or constructed day of ticks/candles for a symbol set — the replay foundation from Chapter 11 §11) is fed into the pipeline exactly as live data would be.
2. The full machine runs — indicators, strategies, risk, Paper Broker (fixed slippage/charge config, no randomness), positions, PnL.
3. The output — **every signal, every risk decision, every order, every fill, final positions and PnL** — is compared against a committed golden record.

**Any diff fails the build.** An *intended* behavior change updates the golden record in the same PR, making the behavioral consequence of the change **visible in review as a diff of trades** — which is exactly the right artifact for a reviewer of a trading system to stare at (Chapter 25 §8).

**What this uniquely catches:** cross-component regressions no unit test sees — a subtle indicator-sequencing change (18 §6), a context-assembly reorder, an accidental await on the critical path — anything that alters *what the machine decides* without breaking any single component's contract. It is Chapter 02 Principle 1 turned into CI.

---

## 5. Failure injection

The failure chapters made recovery promises; tests collect them:

- **Broker timeout mid-order** → order stuck `PLACED` → recovery reconciles-then-decides, never double-executes (12 §8).
- **Boot with a stale `PLACED` order** → reconciliation runs before trading resumes (22 §4).
- **Redis restart mid-session** → orders halt (08 §11); hot state rebuilds; warm-up re-runs (18 §8); trading resumes cleanly.
- **Kill flag persisted → process restart** → still halted (07 `settings`).
- **Malformed AI output** → discarded, sentiment neutral, pipeline unaffected (20 §6) — the fail-neutral test.
- **Feed silence during session** → detected, surfaced, no fabricated data (17 §8).

**Why these are tests and not runbook items:** a recovery path exercised only during real incidents is a recovery path that has never actually been exercised. Each promise above is cheap to simulate and catastrophic to discover broken.

---

## 6. Coverage philosophy & mechanics

- **Critical-path coverage over percentage worship.** The money path — signal → risk → order → fill → position → PnL — targets effectively-complete branch coverage; a uniform "80% overall" number can hide a 50%-covered risk engine behind a 100%-covered formatter, which is exactly backwards. Coverage is reviewed *per package*, weighted by blast radius.
- **Mechanics:** Vitest for unit/integration, Playwright for E2E (Chapter 04 §12); tests colocated per package so Turborepo runs only what changed (Chapter 03 §7, 22 §2); fixtures (candle series, fill sequences, golden records) live beside their tests; **fakes at the seams the architecture already provides** — the `Broker` interface (a scripted fake broker for order-path tests) and repositories — which is dependency injection (05 §3) paying its testing dividend.
- **The CI gate is absolute** (22 §2): red means no route to a broker. No skip-flags culture; a flaky test is fixed or deleted, never tolerated, because a gate people bypass is not a gate.

---

## 7. Roadmap

- **Property-based testing** for position/PnL math and risk boundaries (fast-check) — generated adversarial sequences find the off-by-one-fill bugs example-based tests miss.
- **Golden-run library growth** — more recorded days covering each strategy's suitable *and unsuitable* regimes (16 §9), turning the market-regime table into a regression suite.
- **The backtest harness** (15 §9) as a superset of golden runs — same replay machinery, pointed at strategy evaluation instead of regression.
- **Chaos-style scheduled drills** in staging (22 §8): the §5 injections run against the full deployed stack, gating Phase 3 (Chapter 28).

---

*Previous: **[26_AI_ASSISTANT_RULES.md](26_AI_ASSISTANT_RULES.md)**  ·  Next: **[28_ROADMAP.md](28_ROADMAP.md)** — the phased plan and its gates.*
