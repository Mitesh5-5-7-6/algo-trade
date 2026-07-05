# 26 — AI Assistant Rules

> Prerequisites for the AI itself: read **[00_PROJECT_OVERVIEW.md](00_PROJECT_OVERVIEW.md)** and **[02_MASTER_ARCHITECTURE.md](02_MASTER_ARCHITECTURE.md)** before touching anything. This chapter assumes both.

---

## 1. Purpose — why an AI needs its own chapter

AI assistants (Claude Code and successors) will write a large share of this codebase — likely the majority. That makes the AI the **highest-volume contributor and therefore the highest-volume source of architectural drift** (the failure mode this whole book exists to prevent — Chapter 00, "Why This Matters").

The specific risk is not malice or incompetence; it's *helpfulness without context*. An AI session starts with no memory of why the critical path is synchronous, why there's no manual BUY button, or why the Paper Broker doesn't check capital — and a capable assistant will cheerfully "improve" any of those if not told they are load-bearing. Chapter 25 says what good code looks like; this chapter says **how an AI contributor must operate** so its volume becomes an asset instead of erosion.

---

## 2. Rule 0 — the docs are the source of truth; read before writing

Before any change, the AI must read: **00**, **02**, and **the owning chapter(s)** of whatever it's touching (the chapter map in 00 §8 and the package table in 03 §6 are the routing tables). The docs outrank the AI's general knowledge of "how trading systems are usually built" — *this* system's choices are deliberate and recorded, and where the code and the book disagree, that disagreement is a **bug to flag**, not an ambiguity to resolve silently in either direction.

**Why read-first is Rule 0:** every rule below is derivable from the book. An AI that reads doesn't need this chapter; this chapter exists for the failure mode where it doesn't.

---

## 3. The never list (hard constraints, no clever exceptions)

These restate the invariants (Chapter 02 §11) as contributor prohibitions. Each has been individually justified earlier; the AI does not relitigate them per-task:

1. **Never reorder risk after execution, and never insert asynchrony** (queue, event hop, `setImmediate`, anything) **between signal validation and order placement** — Chapter 14 §2. This is the one most likely to be "helpfully" refactored for symmetry with Regime B. It is asymmetric *on purpose*.
2. **Never create a path to a broker that bypasses the Order Manager** — no direct broker calls from strategies, exits, scripts, or tests-turned-tools. One road (Chapter 12 §2).
3. **Never give the AI Engine execution reach** — no bus events from it, no risk/order imports in it, no widening of the clamp without the evaluation loop (Chapter 20 §2, §7).
4. **Never write state you don't own** — check the ownership map (Chapter 02 §8) before any Mongo/Redis write; wrong-owner writes are the top cause of drift bugs.
5. **Never add manual trade execution as a primary dashboard surface** — Chapter 00 Principle 3, Chapter 06 §4. The absence of a BUY button is a feature with a chapter, not an oversight.
6. **Never weaken a fail-safe "for robustness"** — fail-closed risk (14 §9), fail-neutral AI (20 §4), halt-on-disconnect (12 §7), persisted kill (07): these directions are chosen; flipping one is a regression even when it makes a test pass.
7. **Never handle secrets casually** — no tokens/keys in code, fixtures, logs, or chat output; redaction and placement rules are Chapters 24 §5 and 22 §5.
8. **Never fabricate data to keep a pipeline flowing** — no synthetic prices, bars, or fills when real ones are absent (the honesty rule: 11 §9, 17 §5, 18 §4). Absence is a state; invention is corruption.

---

## 4. Docs move with code — the AI's version

The single-source-of-truth rule (Chapter 00 §9, Chapter 25 §7) applies with extra force to AI contributors, in both directions:

- **Behavior change ⇒ chapter change, same PR.** The AI updates the owning chapter itself — correctly, in the chapter template (00 §9), in the book's voice (every *what* with its *why*).
- **New concepts get one home.** A new event goes in the Chapter 09 catalog (full six attributes); a new collection gets the full Chapter 07 block; a new strategy gets the eleven-attribute Chapter 16 template *including honest weaknesses* (16 §10). Other chapters link; they never re-explain.
- **No shadow docs.** No READMEs, NOTES.md, or inline essays that duplicate book content — parallel explanations are drift with extra steps.

---

## 5. Scope discipline

- **Do what was asked; flag what was found.** Adjacent problems discovered mid-task are *reported* (with chapter references), not silently fixed — an unrequested "fix" is an unreviewed change to a money system.
- **Don't add dependencies casually.** The stack is chosen and justified (Chapter 04); a new package needs the same justify-and-record treatment, proposed before installed.
- **Don't invent unspecified behavior.** If the book doesn't specify and the answer isn't derivable from the invariants, **ask** — a stated assumption in a question costs a minute; an embedded wrong assumption costs a debugging session or a bad trade.
- **Prefer the smallest diff that satisfies the spec.** Large speculative refactors are where never-list violations hide from review (Chapter 25 §9's runnable-PR rule exists for exactly this).

---

## 6. Verification before presenting

Work is not done when it compiles in the AI's head. Before presenting, the AI runs what CI will run (Chapter 22 §2): typecheck, lint, and the tests for the touched packages — and **writes the tests Chapter 27 requires for the layer touched** (a strategy change without its trigger-and-trap tests per 16 §10 is incomplete by definition). If something can't be run in the AI's environment, it says so explicitly rather than implying verification that didn't happen.

**Honesty about uncertainty is a deliverable.** "This should work but I could not execute the integration test" is a good report; silent confidence is not. The reviewer's checklist (Chapter 25 §8) assumes truthful inputs.

---

## 7. Escalation — when the AI must stop and ask

Some changes are **human-decision territory** regardless of how confident the AI is. Stop and ask before:

- Anything touching the **never list** (§3) — even when the task seems to require it; the correct output is "this task conflicts with invariant N, here are the options."
- **Risk semantics** — check logic, limits' meaning, the entry/exit asymmetry (14 §5), kill behavior.
- **Live-broker code paths** (Chapter 19) and anything on the Phase 3 gate (Chapter 28).
- **Deleting or restructuring audit trails** (07's append-only set) or their write paths.
- **Chapter-level rewrites of this book** — chapters record decisions; changing one is changing a decision, which is the operator's call.

**Why escalation is a feature:** the operator-not-trader principle (Chapter 00) applies to contributors too. The AI is a powerful executor inside boundaries a human sets — the same shape as the trading pipeline itself, and for the same reason.

---

## 8. Session-start quick card

For an AI beginning work, the whole chapter in six lines:

1. Read 00, 02, and the owning chapter(s) of what you'll touch.
2. Check the ownership map (02 §8) before any write; check the never list (§3) before any design.
3. Follow Chapter 25 mechanically; use `contracts`/key-builders, typed errors, no magic numbers.
4. Write the Chapter 27 tests for what you changed.
5. Update the owning chapter in the same PR.
6. Unsure, or brushing the never list / risk semantics / live paths? **Stop and ask.**

---

## 9. Roadmap

- **A machine-readable invariants manifest** (lint-enforceable subset of §3, extending 25 §10) so violations fail CI before they reach review.
- **Doc-drift detection** — CI flagging PRs that touch an engine without touching its chapter.
- **This chapter as the AI's system-context file** in Claude Code project configuration, so Rule 0 is delivered automatically rather than remembered.

---

*Previous: **[25_CODING_STANDARDS.md](25_CODING_STANDARDS.md)**  ·  Next: **[27_TESTING.md](27_TESTING.md)** — how correctness is proven at every layer.*
