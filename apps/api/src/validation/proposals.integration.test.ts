import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COLLECTIONS, type MongoConnection } from "@neelkanth/db";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "../test-support/infra.js";
import { INDEX, SYM, seedResearch } from "../test-support/research.js";
import { goldenBudget } from "../replay/test-support.js";
import { DEFAULT_ATTRIBUTION_MODEL } from "../counterfactual/attribution.js";
import { DEFAULT_REGIME_MODEL } from "../counterfactual/regime.js";
import { proposalCatalog } from "../agent/catalog.js";
import { runResearch } from "../agent/loop.js";
import { ScriptedModel } from "../agent/model.js";
import { keepSession } from "../agent/store.js";
import { ToolContext } from "../agent/tools.js";
import { familyOf, registerProposals } from "./proposals.js";
import { listHypotheses, testRegistered } from "./store.js";

/** Task 12.4 (Phase 12 design D2, D4, D5): the operator registers what the agent proposed. */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;
const AS_OF = "2026-01-09";

const proposal = (
  statement: string,
  strategyParams: { name: string; value: number }[] = [],
) => ({
  statement,
  cell: { patternId: "ALL", strategyType: "ORB", symbol: "ALL", regime: "ALL" },
  metric: "expectancy",
  direction: "less",
  threshold: 0,
  strategyParams,
  rationale: [{ statement: "ORB traded in the first week.", cites: ["c1"] }],
});

/** A real session over the seeded research, its answer kept. */
async function keptAnswer(
  proposals: unknown[],
  createdAt: number,
): Promise<string> {
  const session = await runResearch(
    "Propose.",
    new ToolContext(connection.db, AS_OF),
    new ScriptedModel([
      { tools: [{ name: "trade_history", input: { strategies: ["ORB"] } }] },
      {
        tools: [
          {
            name: "submit_answer",
            input: {
              summary: "ORB traded.",
              claims: [
                { statement: "ORB traded in the first week.", cites: ["c1"] },
              ],
              caveats: [],
              proposals,
            },
          },
        ],
      },
    ]),
    { catalog: proposalCatalog([SYM]), maxCorrections: 0 },
  );
  return (await keepSession(connection.db, session, createdAt)).answerId;
}

const request = (answerId: string, over = {}) => ({
  answerId,
  outOfSample: { fromDate: "2026-01-12", toDate: "2026-01-16" },
  run: {
    interval: "5m",
    hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
    ...goldenBudget(),
    seed: 0,
  },
  indexSymbols: [INDEX],
  regime: { ...DEFAULT_REGIME_MODEL, symbol: INDEX },
  attribution: DEFAULT_ATTRIBUTION_MODEL,
  registeredAt: 9_000,
  ...over,
});

let supported: string;

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_proposals",
    "proposal registration",
  );
  if (!probe.reachable) return;
  connection = probe.connection;
  await seedResearch(connection.db);
  supported = await keptAnswer(
    [
      proposal("ORB loses money on average"),
      proposal("ORB with a 30-minute range loses money on average", [
        { name: "rangeMinutes", value: 30 },
      ]),
    ],
    1_000,
  );
}, 300_000);

afterAll(async () => {
  await closeProbe(probe);
});

const skip = () => probe?.reachable !== true;

describe("registering proposals (12.4, D4)", () => {
  it("registers a SUPPORTED answer's proposals as one family — in sample what the agent saw, out of sample after it", async (ctx) => {
    if (skip()) return ctx.skip();
    const strategiesBefore = await connection.db
      .collection(COLLECTIONS.strategies)
      .countDocuments();
    const results = await registerProposals(connection.db, request(supported));
    expect(
      results.map((r) =>
        "registered" in r ? r.registered.hypothesisId : r.refused,
      ),
    ).toEqual(["H-0002", "H-0003"]);
    // The seed holds H-0001 already; these are the family's.
    const [h1, h2] = (await listHypotheses(connection.db)).filter(
      (h) => h.family === familyOf(supported),
    );
    for (const h of [h1, h2])
      expect(h).toMatchObject({
        family: familyOf(supported),
        alpha: 0.05,
        minSample: 30,
        inSample: { fromDate: "2026-01-05", toDate: AS_OF },
        outOfSample: { fromDate: "2026-01-12", toDate: "2026-01-16" },
        run: { symbols: [SYM], indexSymbols: [INDEX] },
      });
    expect(h1?.proposedBy).toEqual({ answerId: supported, proposal: 1 });
    expect(h2?.proposedBy).toEqual({ answerId: supported, proposal: 2 });
    // The variant is pinned as the variant: its own parameters, its own version.
    expect(h2?.run.strategyParams).toEqual({ ORB: { rangeMinutes: 30 } });
    expect(h1?.run.strategyParams).toBeUndefined();
    expect(h2?.pins.strategyVersion).not.toBe(h1?.pins.strategyVersion);
    // D5: nothing became a strategy.
    expect(
      await connection.db.collection(COLLECTIONS.strategies).countDocuments(),
    ).toBe(strategiesBefore);
  }, 300_000);

  it("refuses the same claims a second time, each with why", async (ctx) => {
    if (skip()) return ctx.skip();
    const again = await registerProposals(
      connection.db,
      request(supported, { pick: [1] }),
    );
    expect(again).toEqual([
      {
        proposal: 1,
        refused: expect.stringMatching(
          /already registered as H-0002/,
        ) as string,
      },
    ]);
  }, 300_000);

  it("refuses an out-of-sample window the agent could have seen", async (ctx) => {
    if (skip()) return ctx.skip();
    await expect(
      registerProposals(
        connection.db,
        request(supported, {
          outOfSample: { fromDate: AS_OF, toDate: "2026-01-16" },
        }),
      ),
    ).rejects.toThrow(
      /must start after 2026-01-09, the date the agent saw up to/,
    );
  });

  it("refuses an answer that is not SUPPORTED, or that no longer audits, or a proposal it does not carry", async (ctx) => {
    if (skip()) return ctx.skip();
    const unsupported = await keptAnswer(
      [proposal("X")].map((p) => ({
        ...p,
        cell: { ...p.cell, patternId: "NO_SUCH" },
      })),
      2_000,
    );
    await expect(
      registerProposals(connection.db, request(unsupported)),
    ).rejects.toThrow(/is UNSUPPORTED/);
    await expect(
      registerProposals(connection.db, request(supported, { pick: [3] })),
    ).rejects.toThrow(/there is no proposal 3/);
    await connection.db
      .collection(COLLECTIONS.agentAnswers)
      .updateOne(
        { answerId: supported },
        { $set: { "answer.proposals.0.threshold": -100 } },
      );
    await expect(
      registerProposals(connection.db, request(supported)),
    ).rejects.toThrow(/does not audit/);
  });

  it("is tested like any hypothesis, once its window has closed", async (ctx) => {
    if (skip()) return ctx.skip();
    const t = await testRegistered(connection.db, "H-0002", 10_000);
    expect(t.outOfSample.dateRange).toEqual({
      fromDate: "2026-01-12",
      toDate: "2026-01-16",
    });
  }, 300_000);
});

describe("registration is the operator's, never the agent's (12.4, D4)", () => {
  it("the agent's CLI cannot register: it has no command for it and imports no registry", () => {
    const cli = readFileSync(
      fileURLToPath(new URL("../../scripts/agent.mts", import.meta.url)),
      "utf8",
    );
    expect(cli).not.toMatch(
      /registerProposals|registerHypothesis|validation\/store|validation\/proposals/,
    );
  });
});
