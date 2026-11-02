# Operator skills — conventions

Phase 19 (PLAN.md §33; design
[LIVE_READINESS_AND_EXTENSIONS.md](../../docs/design/LIVE_READINESS_AND_EXTENSIONS.md)
§8). **Code decides, Claude explains.** A skill runs one existing CLI and
explains what it printed. It adds no logic and no numbers of its own.

`node scripts/check-skills.mjs` (`pnpm check:skills`) enforces everything in
this file that a machine can check. Run it before committing a skill.

## Layout

```text
.claude/skills/
  README.md            this file — not a skill
  <name>/SKILL.md      one skill; <name> is kebab-case and equals `name:`
```

One skill wraps one CLI. A skill that would need two CLIs is two skills.

## A SKILL.md

Frontmatter holds `name` (the directory's name) and `description` (when to
use it), and nothing else. In particular there is no `allowed-tools`: every
command a skill runs is approved by the operator at the prompt, as any other
command is.

The body has these sections, under these headings:

| Heading             | What it holds                                                                        |
| ------------------- | ------------------------------------------------------------------------------------ |
| `## When to use`    | The questions it answers, and the nearest ones it does not                           |
| `## Command`        | The exact command lines, in `sh` blocks, each one an allow-listed command (below)    |
| `## Inputs`         | Each flag: what it means, its default, and where a valid value comes from            |
| `## Output`         | Each field the CLI prints and what it means, including the refusal line `refused: …` |
| `## Must not claim` | What this CLI's output does not show — on top of the shared list below               |
| `## Never`          | The never-list below, verbatim between its markers                                   |

Fenced blocks declare their language. Commands go in `sh` blocks; sample
output goes in `text` blocks.

## Commands

A command line has this shape and no other:

```text
[cd <dir> && ]node [--env-file=../../<file>] scripts/<cli> [<subcommand>] [--flag[=value] …]
```

- One command per line: no `;`, `|`, `>`, `<`, backticks, `$(`, or a second `&&`.
- `<cli>`, its directory, its env file, its subcommands and each subcommand's
  flags must match an entry in `ALLOW` in `scripts/check-skills.mjs`.
- A `--db=` value is `neelkanth_research` or a scratch `neelkanth_it_*` /
  `neelkanth_ci_*` database, and nothing else.
- `--env-file=` hands the file to Node. Claude never opens, prints or quotes it.

An `ALLOW` entry is added by the task that adds its skill. That entry cites the
line where its CLI refuses a database it must not touch, so that a skill only
ever invokes CLIs that refuse (design §8 D3). A CLI with no refusal gets no
entry.

## Never

The canonical list. Each `SKILL.md` repeats it verbatim, because the skill's
own file is the only one loaded with it.

<!-- never-list:start -->

- Place, modify or cancel an order, or square off a position.
- Kill, pause or resume trading.
- Change a risk limit, a setting or a strategy, or provision one.
- Take an act a CLI reserves for the operator, such as declaring a candidate.
- Open, print or quote a `.env*` file, a token or a key.
- Call the control-plane API, or connect to MongoDB or Redis directly.
- Run against a paper or Live trading database, or retry a refused command
  with different arguments to get past the refusal.

<!-- never-list:end -->

A refusal (`refused: …`) is the answer. Report it as printed and stop.

## Must not claim — every skill

- That a result is a recommendation, a buy or sell list, or a signal.
- A number the CLI did not print: none computed, rounded differently, or
  extrapolated. Numbers are quoted verbatim.
- That a PASS, a replay, setup odds or a backtest says anything about Live
  profitability, or approves anything for Live.
- That something ran when it was refused, skipped or not run. Skipped is not
  passed.

A skill also never leaves out a refusal, a warning, a sample-size note or a
caveat the CLI printed.
