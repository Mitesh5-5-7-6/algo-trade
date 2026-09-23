# Working in this repository

**Read [`docs/PLAN.md`](docs/PLAN.md) before changing any code.** It is the
single execution authority: it names the current phase, the current task, and
what is allowed to start. Nothing else in this repository decides implementation
order.

This file deliberately contains **no phase or task content**. A copy here would
become another roadmap to drift out of date, which is the problem `docs/PLAN.md`
exists to solve.

## Source of truth

1. `docs/PLAN.md` — implementation order and the next task
2. `docs/architecture/ARCHITECTURE_DECISION.md` — architectural decisions
3. `docs/architecture/RND_RESEARCH_SPECIFICATION.md` — detailed research behaviour
4. Existing source code
5. Tests
6. Older planning documents

Where two documents conflict: PLAN.md wins on **order**, ARCHITECTURE_DECISION
wins on **architecture**, RND_RESEARCH_SPECIFICATION wins on **research
behaviour**.

**Never silently choose between conflicting documents. Report the conflict.**

`docs/architecture/CURRENT_STATE.md` answers "what exists today" and is worth
reading before assuming something is or is not built.

## Ending a planning analysis

Per PLAN.md §25, close with:

```text
CURRENT PHASE:
CURRENT TASK:
WHY THIS TASK:
DEPENDENCIES:
FILES TO INSPECT:
FILES TO CHANGE:
ACCEPTANCE TEST:
TASK STATUS SET TO:
NEXT TASK:
```

Only one task is actively implemented at a time.

## Two things that bite

**`plan/NN §X` citations in source comments point at a deleted document set.**
Roughly 900 of them. They resolve through the bridge table in
[`docs/README.md`](docs/README.md). Do not rewrite the comments.

**Build output can be stale across branches.** `pnpm --filter <pkg> typecheck`
checks against `dist/`, not `src/`, so a branch switch can produce type errors
about fields that do not exist on the current branch. Run `pnpm build` first —
or `pnpm typecheck`, which chains it.
