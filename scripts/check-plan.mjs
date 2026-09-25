#!/usr/bin/env node
/**
 * Verify that `docs/PLAN.md` still describes reality.
 *
 * PLAN.md §26 makes "documentation reflects the actual state" a condition of a
 * phase being done, and §4 requires every COMPLETE row to name its evidence.
 * Neither is enforceable by good intentions: this project has already produced
 * a commit that implemented three tasks and, in the same commit, left a board
 * saying they had not been started.
 *
 * So this checks the half a machine can check — that a claim points at
 * something real:
 *
 *   - every COMPLETE row names evidence, and every path in it exists
 *   - every commit a row cites resolves in this repository
 *   - every BLOCKED row gives a reason
 *   - every phase's STATUS matches the derivation in §4 from its task rows
 *
 * It deliberately cannot check the reverse — code landing without the board
 * being updated. Nothing automatic can. §25's `TASK STATUS SET TO:` line is
 * the human half of the same job.
 *
 * Zero dependencies, so it can run as a CI step without an install.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const PLAN = "docs/PLAN.md";
const VALID = new Set(["COMPLETE", "IN PROGRESS", "READY", "BLOCKED"]);

const problems = [];
const fail = (where, message) => problems.push(`${where}: ${message}`);

const plan = readFileSync(PLAN, "utf8");
const lines = plan.split("\n");

/** Split a markdown table row into trimmed cells. */
function cells(line) {
  return line
    .slice(line.indexOf("|") + 1, line.lastIndexOf("|"))
    .split("|")
    .map((cell) => cell.trim());
}

const isRow = (line) =>
  /^\s*\|/.test(line) && !/^\s*\|[\s|:-]+\|\s*$/.test(line);

/** Paths look like `a/b/c.ts` inside backticks; prose and links do not. */
function pathsIn(text) {
  return [...text.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((token) => /^[\w./-]+\.(ts|mjs|json|yml|md)$/.test(token))
    .filter((token) => token.includes("/"));
}

/** Short SHAs appear in the Commit column as `abc1234`. */
function commitsIn(text) {
  return [...text.matchAll(/`([0-9a-f]{7,40})`/g)].map((m) => m[1]);
}

function commitExists(sha) {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// --- Collect the task rows of every phase that has a task table --------------

/** phase number -> { status, tasks: [{id, status, commit, evidence, line}] } */
const phases = new Map();
let current = null;

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];

  const heading = /^## \d+\. Phase (\d+) —/.exec(line);
  if (heading) {
    current = { number: heading[1], status: null, tasks: [] };
    phases.set(heading[1], current);
    continue;
  }
  if (/^## /.test(line) && !heading) current = null;
  if (current === null) continue;

  const declared = /^\*\*STATUS: ([A-Z ]+)\*\*/.exec(line);
  if (declared) {
    current.status = declared[1].trim();
    continue;
  }

  if (!isRow(line)) continue;
  const c = cells(line);
  if (c.length < 3) continue;
  if (!/^\d+\.\d+/.test(c[0])) continue; // not a task row

  current.tasks.push({
    id: c[0],
    status: c[2],
    commit: c.length >= 5 ? c[3] : "",
    evidence: c.length >= 5 ? c[4] : (c[3] ?? ""),
    line: i + 1,
  });
}

if (phases.size === 0)
  fail(PLAN, "no phase sections with task rows were found");

// --- Check each task row -----------------------------------------------------

let checkedPaths = 0;
let checkedCommits = 0;

for (const phase of phases.values()) {
  for (const task of phase.tasks) {
    const where = `${PLAN}:${task.line} (task ${task.id})`;

    if (!VALID.has(task.status)) {
      fail(
        where,
        `STATUS "${task.status}" is not one of ${[...VALID].join(", ")}`,
      );
    }

    if (task.status === "COMPLETE") {
      if (task.evidence === "" || task.evidence === "—") {
        fail(
          where,
          "COMPLETE with no evidence — a completion claim with nothing behind it is an opinion",
        );
      }
      for (const path of pathsIn(task.evidence)) {
        checkedPaths += 1;
        if (!existsSync(path))
          fail(where, `evidence names "${path}", which does not exist`);
      }
    }

    if (task.status === "BLOCKED" && !/reason:/i.test(task.evidence)) {
      fail(
        where,
        'BLOCKED without a "reason:" — a blocker nobody named is a blocker nobody can clear',
      );
    }

    for (const sha of commitsIn(task.commit)) {
      checkedCommits += 1;
      if (!commitExists(sha))
        fail(where, `commit ${sha} does not resolve in this repository`);
    }
  }
}

// --- Check the derived phase status ------------------------------------------

for (const phase of phases.values()) {
  if (phase.tasks.length === 0 || phase.status === null) continue;
  const statuses = phase.tasks.map((t) => t.status);
  const derived = statuses.every((s) => s === "COMPLETE")
    ? "COMPLETE"
    : statuses.some((s) => s === "COMPLETE" || s === "IN PROGRESS")
      ? "IN PROGRESS"
      : "READY";
  if (phase.status !== derived) {
    fail(
      `${PLAN} Phase ${phase.number}`,
      `declares STATUS ${phase.status}, but its task rows derive ${derived} (§4: phase status is derived, never typed)`,
    );
  }
  if (phase.status === "BLOCKED") {
    fail(
      `${PLAN} Phase ${phase.number}`,
      "BLOCKED is a task-level value with no phase-level equivalent (§4)",
    );
  }
}

// --- Report ------------------------------------------------------------------

const taskCount = [...phases.values()].reduce((n, p) => n + p.tasks.length, 0);

if (problems.length > 0) {
  process.stderr.write(
    `\ncheck-plan — ${PLAN} does not match reality:\n\n` +
      problems.map((p) => `  ✗ ${p}\n`).join("") +
      "\n",
  );
  process.exit(1);
}

process.stdout.write(
  `check-plan — ${PLAN} verified: ${String(taskCount)} tasks across ` +
    `${String(phases.size)} phase section(s), ${String(checkedPaths)} evidence ` +
    `path(s) and ${String(checkedCommits)} commit(s) all resolve.\n`,
);
