import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentAnswersRepository,
  ensureIndexes,
  type MongoConnection,
} from "@neelkanth/db";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "../test-support/infra.js";
import { seedResearch } from "../test-support/research.js";
import { runResearch } from "./loop.js";
import { ScriptedModel } from "./model.js";
import { auditAnswer, keepSession } from "./store.js";
import { ToolContext } from "./tools.js";

/** Task 11.4 (design D7): a real session, kept in agent_answers, read back and audited. */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_agent_store",
    "agent answers",
  );
  if (!probe.reachable) return;
  connection = probe.connection;
  await seedResearch(connection.db);
  await ensureIndexes(connection.db);
}, 300_000);

afterAll(async () => {
  await closeProbe(probe);
});

describe("agent_answers (11.4)", () => {
  it("keeps a session once, never edits it, and audits it from the database", async (ctx) => {
    if (probe?.reachable !== true) return ctx.skip();
    const tools = new ToolContext(connection.db, "2026-01-20");
    const session = await runResearch(
      "How many Trades were there?",
      tools,
      new ScriptedModel([
        { tools: [{ name: "trade_history", input: {} }] },
        {
          tools: [
            {
              name: "submit_answer",
              input: {
                summary: "There were Trades.",
                claims: [
                  {
                    statement: "There were Trades in the two weeks.",
                    cites: ["c1"],
                  },
                ],
                caveats: ["one instrument"],
              },
            },
          ],
        },
      ]),
    );
    expect(session).toMatchObject({ status: "ANSWERED", verdict: "SUPPORTED" });
    const kept = await keepSession(connection.db, session, 1_000);
    const repo = new AgentAnswersRepository(connection.db);
    const back = await repo.findById(kept.answerId);
    expect(back).toEqual(kept);
    expect(back === null ? null : auditAnswer(back)).toMatchObject({
      intact: true,
      verdictHolds: true,
      renderedHolds: true,
    });
    await expect(keepSession(connection.db, session, 1_000)).rejects.toThrow(
      /never edited/,
    );
    expect((await repo.recent(10)).map((d) => d.answerId)).toEqual([
      kept.answerId,
    ]);
  }, 120_000);
});
