---
name: board-status
description: Say where the project stands on its board — each phase's status, the tasks in progress, and what docs/PLAN.md names next — after checking that the board still matches the repository. Use when the operator asks what is done, what is in progress, or what comes next. Reads only.
---

# Board status and next task

Runs `scripts/check-plan.mjs` (`pnpm check:plan`), then reads `docs/PLAN.md`
and reports what it says. `docs/PLAN.md` is the single execution authority
(`CLAUDE.md`). This skill reports its order and never sets it. The conventions
are in `.claude/skills/README.md`.

## When to use

- "Where are we?" Give each phase's status from the §4 table.
- "What's in progress?" Give the `IN PROGRESS` task rows.
- "What's next?" Give what §27 (Current priority) names, and the first task
  rows that are not `COMPLETE` in the phases in progress.
- "Is the board right?" The check answers it.

Not for these:

- Whether a task's work is actually good. A `COMPLETE` row cites evidence;
  the check only proves the evidence exists.
- How a paper session or a candidate did. Those are the `paper-report` and
  `candidate-verdicts` skills.

## Command

From the repository root. It reads `docs/PLAN.md` and git, and nothing else.

```sh
node scripts/check-plan.mjs
```

Then read `docs/PLAN.md`: the §4 phase table, the task table of each phase
that is `IN PROGRESS`, and §27. Do not edit it.

## Inputs

None. The command takes no flags.

## Output

When the board holds, one line:

```text
check-plan — docs/PLAN.md verified: 175 tasks across 21 phase section(s), 360 evidence path(s) and 138 commit(s) all resolve.
```

When it does not, a list of problems, each a `✗` line naming the row and what
is wrong, and the command fails:

```text
check-plan — docs/PLAN.md does not match reality:

  ✗ docs/PLAN.md:1271 (task 19.3): commit 3c32f84 does not resolve in this repository
```

The values in these samples are only there to show the format. Never quote
them as a result.

| What           | Meaning                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| `verified`     | Every `COMPLETE` row names evidence that exists and commits that resolve; every phase status matches its rows |
| `✗` lines      | Where the board and the repository disagree. Quote each one                                                   |
| Task `STATUS`  | `COMPLETE`, `IN PROGRESS`, `READY` or `BLOCKED`, as the row says                                              |
| Phase `STATUS` | Derived from its task rows (§4), never typed                                                                  |

In the answer, quote statuses and task IDs as the board writes them.

## Must not claim

- A next task the board does not name. If §27 and the task tables point at
  different work, report both and say they conflict. Do not choose.
- That a task is done because its code exists. Only its row says so.
- That a verified board means the code works. The check proves that the
  cited evidence exists, not that it is right.
- Anything from the board when the check failed, without saying first that
  the board does not match the repository.

## Never

<!-- never-list:start -->

- Place, modify or cancel an order, or square off a position.
- Kill, pause or resume trading.
- Change a risk limit, a setting or a strategy, or provision one.
- Take an act a CLI reserves for the operator, such as declaring a candidate.
- Open, print or quote a `.env*` file, a token or a key.
- Call the control-plane API, or connect to MongoDB or Redis directly.
- Run against a Live trading database, or a paper one except through
  `paper-report`'s two reads; or retry a refused command with different
  arguments to get past the refusal.

<!-- never-list:end -->
