#!/usr/bin/env node
/**
 * Verify the operator skills under `.claude/skills/` keep their conventions
 * (PLAN.md §33, task 19.1; design LIVE_READINESS_AND_EXTENSIONS §8).
 *
 * A skill is instructions to Claude, so what it may run has to be settled
 * before Claude reads it. This checks the half a machine can check:
 *
 *   - frontmatter is `name` (the directory's) and `description`, nothing else
 *   - every required section is there
 *   - the never-list is the canonical one, verbatim
 *   - every shell line is one command, matching an `ALLOW` entry exactly:
 *     the CLI, its directory, its env file, its subcommand and its flags
 *   - a `--db=` is the research database or a scratch one
 *
 * It cannot check that the prose explains the output faithfully. Task 19.5's
 * acceptance — each skill reproducing its CLI's numbers — is that half.
 *
 * Zero dependencies, like check-plan.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SKILLS = ".claude/skills";
const README = `${SKILLS}/README.md`;

/**
 * What a skill may run. Each entry arrives with the task that adds its skill,
 * and cites where its CLI refuses a database it must not touch (design §8
 * D3): a CLI with no refusal gets no entry — unless it can reach no database
 * at all (no env file, no --db), when its refusal is null.
 *
 *   key        `<dir>/scripts/<cli>` — the dir is "." for the repo root
 *   env        the one env file it may be given, or null for none
 *   refusal    file:line of the refusal, or null (above)
 *   databases  the --db values it may take, when not research or scratch
 *   commands   subcommand ("" for none) → the flags it may take, and those
 *              it must (a --db, so the database is never left to MONGO_URI;
 *              a --dry-run, so asking keeps nothing)
 *
 * @type {Record<string, { env: string | null; refusal: string | null; databases?: RegExp; commands: Record<string, { flags: readonly string[]; required?: readonly string[] }> }>}
 */
export const ALLOW = {
  // Task 19.3: what a strategy would have done over stored candles.
  "apps/api/scripts/replay.mts": {
    env: ".env.local",
    refusal: "apps/api/scripts/replay.mts:54",
    commands: {
      "": {
        flags: [
          "--strategy-type",
          "--params",
          "--symbols",
          "--index-symbols",
          "--from",
          "--to",
          "--capital",
          "--seed",
          "--exit-rules",
          "--db",
          "--dns",
          "--dry-run",
        ],
        required: ["--db", "--dry-run"],
      },
    },
  },
  // Task 19.4: one plan's odds, by resampling and by its rule's history.
  // Always a dry run: a kept run is the operator's.
  "apps/api/scripts/odds.mts": {
    env: ".env.local",
    refusal: "apps/api/scripts/odds.mts:69",
    commands: {
      "": {
        flags: [
          "--symbol",
          "--side",
          "--entry",
          "--stop",
          "--target",
          "--date",
          "--time",
          "--rule-type",
          "--rule-params",
          "--index-symbols",
          "--replays",
          "--seed",
          "--window",
          "--pool-sessions",
          "--capital",
          "--db",
          "--dns",
          "--dry-run",
        ],
        required: ["--db", "--dry-run"],
      },
    },
  },
  // Task 19.3: the candidates and their verdicts — the two reads only.
  // declare is the operator's act; walk-forward and backtest --save keep
  // results, and a new walk-forward changes what verdict judges by default.
  "apps/api/scripts/validation.mts": {
    env: ".env.local",
    refusal: "apps/api/scripts/validation.mts:74",
    commands: {
      list: { flags: ["--db", "--dns"], required: ["--db"] },
      verdict: {
        flags: ["--candidate", "--walk-forward", "--db", "--dns"],
        required: ["--candidate", "--db"],
      },
    },
  },
  // Task 19.2: the board, verified. Reads docs/PLAN.md and git; no database.
  "./scripts/check-plan.mjs": {
    env: null,
    refusal: null,
    commands: { "": { flags: [] } },
  },
  // Task 19.2, design §8 D6: a paper session's report, read and never kept.
  // provision and a kept report stay the operator's.
  "apps/api/scripts/paper.mts": {
    env: ".env.paper",
    refusal: "apps/api/scripts/paper.mts:66",
    databases: /^neelkanth_(paper|it_.+|ci_.+)$/,
    commands: {
      report: {
        flags: ["--session", "--db", "--dns", "--dry-run"],
        required: ["--db", "--dry-run"],
      },
      reports: { flags: ["--limit", "--db", "--dns"], required: ["--db"] },
    },
  },
};

export const REQUIRED_SECTIONS = [
  "## When to use",
  "## Command",
  "## Inputs",
  "## Output",
  "## Must not claim",
  "## Never",
];

const NEVER = /<!-- never-list:start -->([\s\S]*?)<!-- never-list:end -->/;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SCRATCH_OR_RESEARCH = /^neelkanth_(research|it_.+|ci_.+)$/;
const SHELL = new Set(["sh", "bash", "shell", "powershell", "pwsh"]);
const CHAINING = /;|\||>|<|`|\$\(|&&/;
/** A value the operator supplies: `<from>`, or a quoted `"<question>"`. */
const PLACEHOLDER = /<[\w.-]+>/g;
const POSITIONAL = /^"?<[\w.-]+>"?$/;

/** The canonical never-list, from the README, whitespace-normalised. */
export function neverListOf(text) {
  const m = NEVER.exec(text);
  return m === null ? null : m[1].replace(/\s+/g, " ").trim();
}

/** `{ lang, lines }` for each fenced block. */
function fences(text) {
  return [...text.matchAll(/^```([^\n]*)\n([\s\S]*?)^```/gm)].map((m) => ({
    lang: m[1].trim(),
    lines: m[2].split("\n").map((l) => l.trim()),
  }));
}

/**
 * Problems with one command line, or [] when it is allowed. Placeholders
 * such as `<from>` are values, so `--from=<from>` is fine.
 */
export function checkCommand(line, allow = ALLOW) {
  let rest = line;
  let dir = ".";
  const cd = /^cd\s+(\S+)\s+&&\s+/.exec(rest);
  if (cd !== null) {
    dir = cd[1].replace(/\/$/, "");
    rest = rest.slice(cd[0].length);
  }
  if (CHAINING.test(rest.replace(PLACEHOLDER, "x")))
    return [
      `"${line}": one command per line — no chaining, pipes or redirects`,
    ];
  const tokens = rest.split(/\s+/);
  if (tokens[0] !== "node") return [`"${line}": a command starts with node`];
  let i = 1;
  let env = null;
  if (tokens[i]?.startsWith("--env-file=")) {
    env = tokens[i].slice("--env-file=".length).replace(/^(\.\.\/)+/, "");
    i += 1;
  }
  const script = tokens[i] ?? "";
  if (!script.startsWith("scripts/"))
    return [`"${line}": the CLI is scripts/<cli> in its own directory`];
  const key = `${dir}/${script}`;
  const entry = allow[key];
  if (entry === undefined)
    return [`"${line}": ${key} is not in ALLOW (scripts/check-skills.mjs)`];
  const problems = [];
  if (env !== entry.env)
    problems.push(
      `"${line}": ${key} takes ${entry.env === null ? "no env file" : `--env-file=…/${entry.env}`}`,
    );
  i += 1;
  const sub =
    tokens[i] !== undefined && !tokens[i].startsWith("--") ? tokens[i] : "";
  if (sub !== "") i += 1;
  const allowed = entry.commands[sub];
  if (allowed === undefined)
    return [
      ...problems,
      `"${line}": ${key} ${sub === "" ? "with no subcommand" : `"${sub}"`} is not allowed`,
    ];
  const given = new Set();
  for (const token of tokens.slice(i)) {
    if (!token.startsWith("--")) {
      if (!POSITIONAL.test(token))
        problems.push(
          `"${line}": "${token}" — after the subcommand come --flags, or a <placeholder> the operator supplies`,
        );
      continue;
    }
    const [name, value] = token.split(/=(.*)/s);
    given.add(name);
    if (!allowed.flags.includes(name))
      problems.push(
        `"${line}": ${name} is not allowed for ${key} ${sub}`.trimEnd(),
      );
    // Written out, never a placeholder: the database is not Claude's choice.
    if (
      name === "--db" &&
      !(entry.databases ?? SCRATCH_OR_RESEARCH).test(value ?? "")
    )
      problems.push(
        entry.databases === undefined
          ? `"${line}": --db is neelkanth_research or a scratch neelkanth_it_*/ci_* database`
          : `"${line}": --db for ${key} is one of ${String(entry.databases)}`,
      );
  }
  for (const name of allowed.required ?? [])
    if (!given.has(name))
      problems.push(
        `"${line}": ${key}${sub === "" ? "" : ` ${sub}`} must be given ${name}`,
      );
  return problems;
}

/**
 * Problems with an ALLOW entry's citation, or [] when the cited line — or
 * one of the three after it — refuses. A citation that has drifted off its
 * refusal is caught, not trusted.
 */
export function checkRefusal(
  key,
  refusal,
  read = (file) => readFileSync(file, "utf8"),
  entry = undefined,
) {
  if (!existsSync(key)) return [`ALLOW ${key}: no such CLI`];
  if (refusal === null) {
    const reaches =
      entry === undefined ||
      entry.env !== null ||
      Object.values(entry.commands).some((c) => c.flags.includes("--db"));
    return reaches
      ? [`ALLOW ${key}: no refusal, yet it can reach a database`]
      : [];
  }
  const [file = "", at = ""] = refusal.split(":");
  const lineNo = Number(at);
  if (!existsSync(file) || !Number.isInteger(lineNo) || lineNo < 1)
    return [`ALLOW ${key}: its refusal ${refusal} is not file:line`];
  const near = read(file)
    .split("\n")
    .slice(lineNo - 1, lineNo + 3)
    .join("\n");
  return /refus/.test(near)
    ? []
    : [`ALLOW ${key}: ${refusal} does not refuse — has the line moved?`];
}

/** Problems with one SKILL.md, or [] when it keeps the conventions. */
export function checkSkill(dirName, text, never, allow = ALLOW) {
  const problems = [];
  if (!KEBAB.test(dirName))
    problems.push("the directory name is not kebab-case");

  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (front === null) {
    problems.push("no frontmatter");
  } else {
    const fields = new Map(
      front[1]
        .split("\n")
        .filter((l) => /^[\w-]+:/.test(l))
        .map((l) => [
          l.slice(0, l.indexOf(":")),
          l.slice(l.indexOf(":") + 1).trim(),
        ]),
    );
    if (fields.get("name") !== dirName)
      problems.push(`name: must be "${dirName}", the directory's name`);
    if ((fields.get("description") ?? "") === "")
      problems.push("description: is missing");
    for (const key of fields.keys())
      if (key !== "name" && key !== "description")
        problems.push(
          `frontmatter "${key}:" — only name and description (no allowed-tools)`,
        );
  }

  const headings = new Set(text.split("\n").map((l) => l.trim()));
  for (const section of REQUIRED_SECTIONS)
    if (!headings.has(section)) problems.push(`missing section "${section}"`);

  const own = neverListOf(text);
  if (own === null) problems.push("the never-list markers are missing");
  else if (own !== never)
    problems.push("the never-list differs from .claude/skills/README.md");

  let commands = 0;
  for (const block of fences(text)) {
    if (block.lang === "") {
      problems.push(
        "a fenced block declares no language (sh for commands, text for output)",
      );
      continue;
    }
    if (!SHELL.has(block.lang)) continue;
    for (const line of block.lines) {
      if (line === "" || line.startsWith("#")) continue;
      commands += 1;
      problems.push(...checkCommand(line, allow));
    }
  }
  if (commands === 0) problems.push("no command — a skill runs one CLI");
  return problems;
}

function main() {
  const never = neverListOf(readFileSync(README, "utf8"));
  if (never === null) {
    process.stderr.write(
      `check-skills — ${README} has no never-list markers\n`,
    );
    process.exit(1);
  }
  const problems = [];
  for (const [key, entry] of Object.entries(ALLOW))
    problems.push(...checkRefusal(key, entry.refusal, undefined, entry));
  const dirs = readdirSync(SKILLS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const dir of dirs) {
    const file = join(SKILLS, dir, "SKILL.md");
    if (!existsSync(file)) {
      problems.push(`${SKILLS}/${dir}: no SKILL.md`);
      continue;
    }
    for (const p of checkSkill(dir, readFileSync(file, "utf8"), never))
      problems.push(`${SKILLS}/${dir}/SKILL.md: ${p}`);
  }
  if (problems.length > 0) {
    process.stderr.write(
      "\ncheck-skills — skills break their conventions:\n\n" +
        problems.map((p) => `  ✗ ${p}\n`).join("") +
        "\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `check-skills — ${String(dirs.length)} skill(s) keep the conventions; ` +
      `${String(Object.keys(ALLOW).length)} CLI(s) allowed.\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  main();
