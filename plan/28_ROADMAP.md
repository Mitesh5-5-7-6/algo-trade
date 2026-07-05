# 28 — Roadmap

> Prerequisite: **[00_PROJECT_OVERVIEW.md](00_PROJECT_OVERVIEW.md)** §6 (the three-phase logic this chapter operationalizes). This chapter also *gathers* — the gate items scattered through earlier roadmap sections converge here into checklists.

---

## 1. Purpose — a sequence with gates, not a wishlist

This roadmap is dependency-ordered, and each phase ends in an **explicit exit gate** that is the next phase's entry condition. The governing rule:

> **No phase is skipped, and no gate is waived. Real capital is exposed only after every cheaper phase has failed to find the bug.**

**Why gates instead of dates:** dates create pressure to ship past problems; gates create pressure to *solve* them. For a system whose failure mode is losing money autonomously, the schedule risk of a slipped phase is trivially cheaper than the capital risk of a skipped check. Dates below are absent on purpose.

---

## 2. Phase 0 — Foundation

**Build:** the monorepo skeleton (03), `core`/`contracts` with the first Zod schemas, `config` fail-fast loading (04 §6), `logger`, `redis` and `db` packages with namespace/key builders and repositories (08 §9, 03 §5), the composition root (05 §3), CI pipeline (22 §2), and the health model (23 §4).

**Why first:** every later phase writes code *into* these boundaries; retrofitting package rules, typed events, or fail-fast config onto a working pipeline is 10× the cost of starting inside them.

**Exit gate:** □ boots with validated config and fails fast on bad config □ liveness/readiness green against real Redis+Mongo □ CI red-blocks a deliberately broken commit □ dependency-direction violation fails the build (03 §5).

---

## 3. Phase 1 — Paper trading (the proving ground)

**Build, in dependency order:** Broker interface + FYERS *data side* + token lifecycle jobs (19 §2–4) → Market Data Engine with candles + session manager (17) → Indicator Engine with warm-up (18) → Strategy Engine + **two or three strategies first** (15; suggest EMA, ORB, RSI — one trend, one breakout, one mean-reversion, exercising different context features) → Risk Engine, all four checks + asymmetry (14) → Order Manager + Paper Broker (12, 11) → Position/Portfolio/PnL chain + EOD reconcile (13) → Socket.IO bridge + dashboard control center (10, 06) → auth (21). Then the remaining five strategies to the Chapter 16 template.

**Why 2–3 strategies before all eight:** the first strategies exist to harden the *pipeline*; eight at once multiplies debugging surface while proving nothing extra. The remaining five are added when a signal misbehaving means the *strategy* is wrong, not the plumbing.

**Exit gate (the pipeline-trust checklist):**
□ All 8 strategies implemented, each with its 16 §10 trigger-and-trap tests
□ Golden-run suite green and gating CI (27 §4)
□ Idempotency and failure-injection tests green (27 §3, §5)
□ **N consecutive live-market paper sessions clean** (suggest N=20): no unresolved `SYSTEM_ERROR`, daily reconcile divergence zero (13 §6), no unreconciled orders
□ **Kill-switch drill passed live:** kill mid-session → halt verified → restart → still halted (07) → deliberate re-enable
□ Token-refresh job has survived real mornings unattended (19 §3)
□ Backup + **restore rehearsal** completed at least once (22 §6, 23 §7)
□ Paper P&L per strategy reviewed against its 16 §9 regime expectations — strategies behaving *as documented*, including losing where the book says they lose

---

## 4. Phase 2 — AI assist

**Build:** `jobs:news` fetch + `news` collection (07, 20 §3) → summarize + sentiment jobs with the Zod-validate-clamp firewall → `cache:sentiment` TTL path → context integration + confidence modulation (15 §3, §6) → AI Summaries page (06 §4) → the evaluation loop (20 §7).

**Why strictly after Phase 1:** a layer that *modulates* a pipeline is only debuggable against a trusted baseline (00 §6). If a trade looks wrong in Phase 2, the question "strategy or sentiment?" must be answerable — and it only is because Phase 1 established what the strategy alone would have done (the golden runs are that record).

**Exit gate:**
□ **Fail-neutral verified by test and by drill** — news API down / LLM erroring / all TTLs expired ⇒ behavior identical to Phase 1 (20 §4, 27 §5)
□ Malformed-output firewall test green; dead-letters inspectable (20 §6)
□ Every sentiment-influenced signal's `contextSnapshot` traces to stored news (07 `news`, 20 §3.7)
□ Confidence bounds config-clamped and honored under adversarial fixture news (24 §4)
□ Evaluation loop running: nudge-vs-outcome data accumulating *before* any bound is widened (20 §7)

---

## 5. Phase 3 — Live trading (the gated swap)

**Build:** the FYERS execution side of the broker (19 §5) — client-order-reference on every order, async fill mapping, rejection translation, rate budget (19 §6) → **bracket/cover orders at the broker** (19 §9, 12 §9: stop-loss survives our process dying — the single biggest live-safety upgrade, built *before* live money, not after) → **TOTP 2FA** (21 §8) → **staging environment** running the full stack (22 §8) → chaos drills in staging (27 §7).

**The go-live gate (every box, no exceptions):**
□ Phases 1–2 gates still green (regressions reopen them)
□ 2FA active on the operator account
□ Staging **reconciliation drill:** process killed mid-submission → restart → reconcile-then-decide verified, zero duplicates (12 §8, 27 §5)
□ Bracket orders verified: broker-side SL persists through our process dying
□ Deploy-timing policy and graceful shutdown exercised in staging (22 §3–4)
□ Alerting act-now tier fires end-to-end to the operator (23 §6)
□ Broker rate budget verified under session-scale replay (19 §6)

**Then — the swap, under capital discipline:** the composition root selects `FyersBroker` (05 §3 — the one-line moment the whole architecture was built for) with: (1) a **small dedicated capital allocation**, (2) **one strategy, one symbol** initially, (3) tight global limits (14) deliberately stricter than paper, (4) widening only on clean live sessions, each widening a logged operator decision. **Why trickle, not switch:** paper proved the *logic*; live microstructure (real slippage, partial fills, rejections) is the one thing paper approximates — it gets proven with the smallest stake that produces real evidence.

---

## 6. Beyond Phase 3 (unordered, each gated on demand)

**Product:** backtest harness as a first-class tool (15 §9, 27 §7) → strategy performance analytics driving allocation (13 §9) → additional strategies (16 §10) → F&O with margin-aware capital (13 §9).
**Platform:** process extraction along the plane seams when load demands (02 §13, 03 §8) → Redis Streams if a consumer ever must not miss history (08 §12, 09 §9) → second broker adapter (19 §9) → multi-operator roles (21 §6, 06).
**Hardening:** the 23–27 roadmap items (Prometheus, external probe, secrets manager, custom lint rules, property-based tests) adopted as scale makes each worth its keep — **the standing rule from Chapter 04: additions are made when measurements demand them, not before.**

---

## 7. Continuous obligations (every phase, no gate needed)

- **Docs move with code, same PR** (25 §7, 26 §4) — this book stays true or it stays useless.
- **The test suite only grows** (27) — a gate once passed is a gate now guarded by CI.
- **Invariants are never relitigated per-task** (02 §11, 26 §3) — changing one is a documented architectural decision, not a refactor.

---

## 8. The roadmap's own why (closing the book's argument)

The sequence *is* the risk model: every phase runs the **same pipeline** against a progressively more real world — fabricated fixtures (tests) → recorded reality (golden runs) → live data with simulated fills (paper) → live data with modulated confidence (AI) → live everything, smallest stake first. At each step, exactly **one** new dimension of reality is introduced, so any new failure has one place to look. That is Chapter 02's interchangeable-broker and deterministic-pipeline decisions paying their final dividend — and it is why the phases cannot be reordered: each one is the controlled experiment that licenses the next.

---

*Previous: **[27_TESTING.md](27_TESTING.md)**  ·  This completes the numbered chapters. The **[MASTER_PROJECT_SPECIFICATION.md](MASTER_PROJECT_SPECIFICATION.md)** ties the book together; **[01_PROJECT_PHILOSOPHY.md](01_PROJECT_PHILOSOPHY.md)** holds the values behind it all.*
