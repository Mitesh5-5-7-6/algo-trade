# 25 — Coding Standards

> Prerequisites: **[03_MONOREPO_STRUCTURE.md](03_MONOREPO_STRUCTURE.md)** (the boundaries these standards enforce), **[02_MASTER_ARCHITECTURE.md](02_MASTER_ARCHITECTURE.md)** §11 (the invariants code review protects).

---

## 1. Purpose — why standards matter *here*

In most codebases, standards buy readability. Here they buy something stronger: **auditability and drift resistance.** This system's safety rests on invariants (Chapter 02 §11) that live in code shape — single choke point, single-owner writes, synchronous critical path. Standards are how N contributors (human and AI, Chapter 26) produce code in which those shapes stay *visible*, so a violation looks wrong before it behaves wrong.

The standards below are **enforced by tooling wherever possible** (ESLint, Prettier, tsconfig, CI — Chapter 22 §2) and by review checklist where tooling can't reach. A standard that depends on memory is a standard that erodes.

---

## 2. Type discipline

- **`strict: true` everywhere; `any` is banned** (lint-enforced; `unknown` + narrowing where genuinely dynamic). **Why absolute:** the shapes flowing through this system are orders and money; an `any` is a hole in the second reviewer that never tires (Chapter 04 §2).
- **Zod-first shapes.** Every boundary shape — entities, configs, event payloads, API requests — is a Zod schema in `core`/`contracts`, with the TS type **inferred** (`z.infer`), never hand-written alongside. **Why:** one definition serves runtime validation *and* compile-time typing (Chapter 04 §4); a hand-duplicated type is a drift bomb.
- **No naked primitives for money-adjacent concepts** where confusion is plausible: quantities, prices, and percentages ride in named fields of validated objects — a bare `number` argument named `value` is how a price gets passed as a quantity.

---

## 3. Naming (one name per concept, everywhere)

| Thing | Convention | Anchor |
|---|---|---|
| Files | `kebab-case.ts`; tests `*.test.ts` colocated | Chapter 03 §7 |
| Types/classes | `PascalCase`; schemas `OrderSchema` → `type Order = z.infer<...>` | — |
| Functions/vars | `camelCase`; booleans read as predicates (`isReady`, `hasPosition`) | — |
| **Events** | `UPPER_SNAKE`, defined **only** in `contracts` — string literals at emit/subscribe sites are lint-banned | Chapter 09 §3 |
| **Redis keys** | namespace-prefixed builders from the `redis` package (`hotPriceKey(symbol)`) — hand-assembled key strings banned | Chapter 08 §9 |
| Collections | as named in Chapter 07, accessed only via repositories | Chapter 03 §5 |

**Why constants-not-literals for events and keys:** a typo'd channel name doesn't error — it silently talks to nobody. Centralized builders turn that silent failure into a compile error.

---

## 4. Boundary rules (the architecture, restated as lint-able law)

1. **Dependency direction is one-way** (Chapter 03 §5, Rule 1) — enforced by TS project references; a cycle is a build failure, not a debate.
2. **One package owns each external system** (Rule 2) — only `db` touches Mongo, only `redis` touches Redis, only `broker` touches FYERS. An import of `mongodb` outside `db` fails lint.
3. **Single-owner state writes** (Chapter 02 §8) — code outside an owner never writes that owner's collections or keys; it calls the owner or emits an event. Reviewers check this explicitly (§8).
4. **No HTTP/event hops inside the critical path** (Chapter 02 §6, Regime A) — signal → risk → order is direct calls; introducing asynchrony there is an architectural regression by definition (Chapter 14 §2).

---

## 5. Error & async discipline

- **Typed domain errors only** (Chapter 05 §5); `throw new Error("oops")` fails review. Errors carry context objects, not interpolated strings, so logs stay structured (Chapter 23 §3).
- **No swallowed errors.** Every `catch` either handles meaningfully, rethrows typed, or logs-and-degrades *visibly* — a bare `catch {}` is the "silent failure" this book bans (Chapter 02 §10) in four characters.
- **No floating promises** (lint: `no-floating-promises`) — an unawaited rejection is an invisible failure.
- **Nothing blocking on the hot path** — no sync I/O, no unbounded loops, no CPU-heavy work in tick/candle/analyze handlers (Chapter 02 §9); heavy work goes to BullMQ (Chapter 08 §6). The event-loop-lag metric (Chapter 23 §5) is the backstop; this rule is the prevention.
- **All external calls have timeouts.** An awaited call with no timeout is a hang waiting for a session to start.

---

## 6. Configuration & literals

- **No magic numbers.** Thresholds, periods, limits live in validated config (`config` package, Chapter 04 §6) or strategy params (Chapter 07) — never inline. **Why beyond tidiness:** an inline `0.75` gap threshold is invisible to the operator and unauditable in a decision record; a named, validated parameter is both.
- **No secrets in code, tests, fixtures, or logs** — env-supplied only (Chapter 22 §5, Chapter 24 §5); the logger's redaction list is part of the standard, not an ops afterthought.

---

## 7. Comments & documentation

- **Comments explain *why*, not *what*** — the code says what; the comment carries the reasoning or the trap ("Wilder seed, not SMA — Ch 16 §3"). A comment restating the line below it is noise that rots.
- **Docs move with code.** A PR that changes behavior specified in this book **must** update the owning chapter in the same PR (single-source-of-truth rule, Chapter 00 §9). *Why in the same PR:* "docs later" is how this book and the codebase diverge — and a wrong operating manual for a trading system is worse than none.
- **Strategy code links its spec:** every strategy implementation cites its Chapter 16 section; drift between formula-in-code and formula-in-book is a bug in whichever is wrong.

---

## 8. Review checklist (what a human must still check)

Tooling enforces §2–§6 mechanically. The reviewer's residual job is the checklist CI can't run:

1. Does this change **weaken any Chapter 02 §11 invariant**? (Risk-before-broker order; sync critical path; single choke point; single-owner writes; presentation out of critical path; broker behind interface; AI bounded.) If yes → architectural regression, not a style note.
2. New state? → **who owns it**, and is that recorded (Chapter 02 §8, Chapter 07)?
3. New event? → **catalogued in Chapter 09** with producer/consumer/payload/retry, payload schema in `contracts`?
4. New failure mode? → visible, logged, alert-tiered (Chapter 23)?
5. Tests per Chapter 27's bar for the layer touched — and honest ones, not coverage theater.
6. Docs updated in-PR (§7)?

**Why a checklist and not judgment:** judgment is exactly what erodes at 5 pm on a Friday. The checklist is short enough to actually run and pointed enough to catch what matters.

---

## 9. Formatting & mechanics

Prettier (unmodified defaults) + ESLint, both CI-gating (Chapter 22 §2). **Why defaults:** every format debate is time not spent on the pipeline; the value is uniformity, not any particular brace style. Commits: small, single-purpose, imperative subject; PRs small enough that the §8 checklist is *actually runnable* against them — a 3,000-line PR makes every review guarantee fictional.

---

## 10. Roadmap

- **Custom lint rules** for the boundary bans in §3–§4 (event literals, cross-package infra imports, hot-path sync I/O) as the codebase grows past manual vigilance.
- **Danger/PR-bot** automating checklist reminders (docs-updated?, event-catalogued?).

---

*Previous: **[24_SECURITY.md](24_SECURITY.md)**  ·  Next: **[26_AI_ASSISTANT_RULES.md](26_AI_ASSISTANT_RULES.md)** — the operating rules for the highest-volume contributor.*
