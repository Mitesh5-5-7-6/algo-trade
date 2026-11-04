/**
 * Task 19.1 — the skill conventions, enforced. `pnpm test:scripts`.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ALLOW as REAL_ALLOW,
  checkCommand,
  checkRefusal,
  checkSkill,
  neverListOf,
} from "./check-skills.mjs";

const NEVER = neverListOf(readFileSync(".claude/skills/README.md", "utf8"));
const NEVER_BLOCK =
  /<!-- never-list:start -->[\s\S]*?<!-- never-list:end -->/.exec(
    readFileSync(".claude/skills/README.md", "utf8"),
  )?.[0];

/** A CLI shaped like the research ones, for the tests only. */
const ALLOW = {
  "apps/api/scripts/replay.mts": {
    env: ".env.local",
    refusal: "apps/api/scripts/replay.mts:1",
    commands: {
      "": {
        flags: ["--strategy-type", "--from", "--to", "--dry-run", "--db"],
        required: ["--dry-run"],
      },
    },
  },
  "apps/api/scripts/agent.mts": {
    env: ".env.agent.local",
    refusal: "apps/api/src/agent/guard.ts:1",
    commands: {
      ask: { flags: ["--as-of", "--no-keep"] },
      audit: { flags: ["--limit"] },
    },
  },
  "./scripts/check-plan.mjs": {
    env: null,
    refusal: "scripts/check-plan.mjs:1",
    commands: { "": { flags: [] } },
  },
};

const REPLAY =
  "cd apps/api && node --env-file=../../.env.local scripts/replay.mts --strategy-type=ORB --from=<from> --to=<to> --dry-run";

function skill({
  name = "replay",
  front = `name: ${name}\ndescription: Replay one strategy over stored candles.`,
  commands = [REPLAY],
  never = NEVER_BLOCK,
  drop = "",
} = {}) {
  const text = [
    `---\n${front}\n---\n`,
    "# Replay\n",
    "## When to use\n\nWhat would this strategy have done.\n",
    "## Command\n",
    "```sh\n" + commands.join("\n") + "\n```\n",
    "## Inputs\n\n--from, --to.\n",
    "## Output\n\n```text\ntrades 3\n```\n",
    "## Must not claim\n\nThat it would have made money live.\n",
    `## Never\n\n${never}\n`,
  ].join("\n");
  return drop === "" ? text : text.replace(`${drop}\n`, "");
}

const check = (opts) =>
  checkSkill(opts?.name ?? "replay", skill(opts), NEVER, ALLOW);

describe("a skill that keeps the conventions", () => {
  it("passes", () => {
    assert.ok(NEVER !== null && NEVER.length > 0);
    assert.deepEqual(check(), []);
  });

  it("may run a CLI with no env file from the repository root", () => {
    assert.deepEqual(checkCommand("node scripts/check-plan.mjs", ALLOW), []);
  });

  it("may pass a placeholder the operator supplies", () => {
    assert.deepEqual(
      checkCommand(
        'cd apps/api && node --env-file=../../.env.agent.local scripts/agent.mts ask "<question>" --as-of=<date>',
        ALLOW,
      ),
      [],
    );
  });

  it("may name the research or a scratch database", () => {
    for (const db of ["neelkanth_research", "neelkanth_it_x", "neelkanth_ci_y"])
      assert.deepEqual(checkCommand(`${REPLAY} --db=${db}`, ALLOW), []);
  });
});

describe("frontmatter", () => {
  it("names the directory", () => {
    assert.match(
      check({ name: "replay-x", front: "name: replay\ndescription: d" }).join(),
      /name: must be "replay-x"/,
    );
  });

  it("has a description", () => {
    assert.match(
      check({ front: "name: replay" }).join(),
      /description: is missing/,
    );
  });

  /** Pre-approving a command would skip the operator's prompt. */
  it("holds no allowed-tools", () => {
    assert.match(
      check({
        front: "name: replay\ndescription: d\nallowed-tools: Bash",
      }).join(),
      /allowed-tools/,
    );
  });

  it("is kebab-case", () => {
    assert.match(
      checkSkill(
        "Replay_Skill",
        skill({ name: "Replay_Skill" }),
        NEVER,
        ALLOW,
      ).join(),
      /kebab-case/,
    );
  });
});

describe("sections", () => {
  for (const section of [
    "## When to use",
    "## Inputs",
    "## Output",
    "## Must not claim",
  ])
    it(`requires ${section}`, () => {
      const text = skill().replace(
        new RegExp(`^${section}$`, "m"),
        "## Something else",
      );
      assert.match(
        checkSkill("replay", text, NEVER, ALLOW).join(),
        new RegExp(`missing section "${section}"`),
      );
    });

  it("repeats the never-list verbatim", () => {
    assert.match(
      check({
        never: NEVER_BLOCK.replace(
          "Kill, pause or resume trading.",
          "Kill trading.",
        ),
      }).join(),
      /never-list differs/,
    );
  });

  it("has the never-list's markers", () => {
    assert.match(check({ never: "- nothing" }).join(), /markers are missing/);
  });

  it("runs a command", () => {
    assert.match(check({ commands: ["# nothing"] }).join(), /no command/);
  });

  it("declares each fenced block's language", () => {
    const text = skill().replace("```text", "```");
    assert.match(
      checkSkill("replay", text, NEVER, ALLOW).join(),
      /declares no language/,
    );
  });
});

describe("commands (design §8 D3)", () => {
  const refused = (line, pattern) =>
    assert.match(checkCommand(line, ALLOW).join(), pattern);

  it("refuses a CLI not in ALLOW", () => {
    refused(
      "cd apps/api && node --env-file=../../.env.paper scripts/paper.mts provision",
      /not in ALLOW/,
    );
  });

  it("refuses the wrong env file", () => {
    refused(
      REPLAY.replace(".env.local", ".env.paper"),
      /takes --env-file=…\/.env.local/,
    );
  });

  it("refuses a missing env file where one is needed", () => {
    refused(
      REPLAY.replace(" --env-file=../../.env.local", ""),
      /takes --env-file/,
    );
  });

  it("refuses a subcommand it does not list", () => {
    refused(
      'cd apps/api && node --env-file=../../.env.agent.local scripts/agent.mts propose "<q>"',
      /"propose" is not allowed/,
    );
  });

  it("refuses a flag it does not list", () => {
    refused(`${REPLAY} --save`, /--save is not allowed/);
  });

  it("refuses a database that is neither research nor scratch", () => {
    for (const db of [
      "neelkanth_paper",
      "neelkanth",
      "neelkanth_live",
      "neelkanth_researchx",
    ])
      refused(
        `${REPLAY} --db=${db}`,
        /--db is neelkanth_research or a scratch/,
      );
  });

  for (const [what, line] of [
    ["a second command", `${REPLAY} && curl localhost:4000/kill`],
    ["a pipe", `${REPLAY} | tee out.txt`],
    ["a redirect", `${REPLAY} > out.txt`],
    ["a sequence", `${REPLAY}; cat .env.local`],
    ["a substitution", `${REPLAY} --from=$(date)`],
    ["backticks", `${REPLAY} --from=\`date\``],
  ])
    it(`refuses ${what}`, () => {
      refused(line, /one command per line/);
    });

  for (const line of [
    "cat ../../.env.local",
    "curl -X POST localhost:4000/kill",
    "mongosh neelkanth",
    "pnpm check:plan",
  ])
    it(`refuses "${line}" — not node`, () => {
      refused(line, /starts with node/);
    });

  it("refuses a loose argument that is not a placeholder", () => {
    refused(`${REPLAY} extra`, /--flags, or a <placeholder>/);
  });

  it("checks commands in every shell block, not only under ## Command", () => {
    const text = skill().replace(
      "## Inputs\n",
      "## Inputs\n\n```bash\ncat .env.local\n```\n",
    );
    assert.match(
      checkSkill("replay", text, NEVER, ALLOW).join(),
      /starts with node/,
    );
  });
});

describe("required flags and the database (19.3)", () => {
  it("refuses a command missing a flag it must be given", () => {
    assert.match(
      checkCommand(REPLAY.replace(" --dry-run", ""), ALLOW).join(),
      /must be given --dry-run/,
    );
  });

  /** A placeholder would leave the database to whoever fills it in. */
  it("refuses a --db left as a placeholder", () => {
    assert.match(
      checkCommand(`${REPLAY} --db=<db>`, ALLOW).join(),
      /--db is neelkanth_research or a scratch/,
    );
  });

  it("makes every real database-reading command name its database", () => {
    for (const [key, entry] of Object.entries(REAL_ALLOW))
      for (const [sub, cmd] of Object.entries(entry.commands))
        assert.ok(
          cmd.required?.includes("--db"),
          `${key} ${sub} must require --db`,
        );
  });
});

describe("refusal citations (19.3)", () => {
  it("every real ALLOW entry cites a line that refuses", () => {
    assert.ok(Object.keys(REAL_ALLOW).length > 0);
    for (const [key, entry] of Object.entries(REAL_ALLOW))
      assert.deepEqual(checkRefusal(key, entry.refusal), []);
  });

  const key = "apps/api/scripts/replay.mts";
  const file = (lines) => () => lines.join("\n");

  it("catches a citation that has drifted off its refusal", () => {
    assert.match(
      checkRefusal(
        key,
        `${key}:1`,
        file(["import x;", "a", "b", "c", "refusing"]),
      ).join(),
      /does not refuse/,
    );
  });

  it("accepts a refusal within three lines of the cited one", () => {
    assert.deepEqual(
      checkRefusal(
        key,
        `${key}:2`,
        file(["x", "if (bad)", "throw new Error(", "  'refusing'"]),
      ),
      [],
    );
  });

  it("catches a citation that is not file:line", () => {
    assert.match(checkRefusal(key, key).join(), /not file:line/);
    assert.match(checkRefusal(key, "nowhere.ts:3").join(), /not file:line/);
  });
});
