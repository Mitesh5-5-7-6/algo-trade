/**
 * The AI research agent (Phase 11, 11.5).
 *
 *   node --env-file=../../.env.agent.local scripts/agent.mts <command> [options]
 *
 *   ask "<question>" [--as-of=YYYY-MM-DD] [--effort=medium|high|xhigh]
 *                    [--no-keep]      answer a research question as of a date
 *   show <answerId>                   a kept answer, and its audit
 *   audit [--limit=20]                audit the most recent kept answers
 *
 * Every command takes [--db=neelkanth_research] [--dns=1.1.1.1].
 *
 * Its own env file — ANTHROPIC_API_KEY and the research MONGO_URI, nothing
 * else (see .env.agent.local.example). It refuses to start beside a broker or
 * production secret, so it cannot be run with .env.local (design D5). It
 * reads the research database only, through six read-only tools, and writes
 * one thing: the answer, to agent_answers (unless --no-keep). Research text
 * is sent to Anthropic's API (design Q1).
 *
 * Runs the BUILT code: `pnpm build` first.
 */
import {
  assertAgentEnvironment,
  assertResearchDatabase,
} from "../dist/agent/guard.js";

// Before anything else is read or connected (D5).
assertAgentEnvironment(process.env);

const dns = await import("node:dns");
const { MongoClient } = await import("mongodb");
const { istDateKey } = await import("@neelkanth/core");
const { AgentAnswersRepository } = await import("@neelkanth/db");
const { runResearch } = await import("../dist/agent/loop.js");
const { AnthropicResearchModel } = await import("../dist/agent/model.js");
const { auditAnswer, keepSession } = await import("../dist/agent/store.js");
const { ToolContext } = await import("../dist/agent/tools.js");
const { default: Anthropic } = await import("@anthropic-ai/sdk");

const [command, ...rest] = process.argv.slice(2);
const positional = rest.filter((a) => !a.startsWith("--"));
const args = new Map(
  rest
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const eq = a.indexOf("=");
      return eq === -1
        ? ([a.slice(2), "true"] as const)
        : ([a.slice(2, eq), a.slice(eq + 1)] as const);
    }),
);
if (!["ask", "show", "audit"].includes(command ?? ""))
  throw new Error(
    'usage: agent.mts ask "<question>" | show <answerId> | audit',
  );

const resolvers = (args.get("dns") ?? "").split(",").filter(Boolean);
if (resolvers.length > 0) dns.setServers(resolvers);
const client = new MongoClient(process.env["MONGO_URI"] ?? "");
await client.connect();
try {
  const db = client.db(args.get("db"));
  assertResearchDatabase(db.databaseName);
  const repo = new AgentAnswersRepository(db);
  const showAudit = (a: ReturnType<typeof auditAnswer>) =>
    `audit        ${a.intact && a.verdictHolds && a.renderedHolds ? "holds" : "FAILS"} (fingerprint ${a.intact ? "ok" : "CHANGED"}, verdict ${a.verdictHolds ? "ok" : "DIFFERS"}, text ${a.renderedHolds ? "ok" : "DIFFERS"})`;

  if (command === "ask") {
    const question = positional.join(" ").trim();
    if (question === "") throw new Error('ask needs a question: ask "…"');
    const asOf = args.get("as-of") ?? istDateKey(Date.now());
    const effort = (args.get("effort") ?? "high") as
      "medium" | "high" | "xhigh";
    const startedAt = Date.now();
    const session = await runResearch(
      question,
      new ToolContext(db, asOf),
      new AnthropicResearchModel(new Anthropic(), undefined, effort),
    );
    console.log(session.rendered);
    console.log("");
    console.log(`database     ${db.databaseName}, as of ${asOf}`);
    console.log(
      `session      ${session.status}, ${session.verdict}; ${String(session.turns)} turns, ${String(session.calls.length)} tool calls, ${String(session.corrections)} corrections`,
    );
    console.log(
      `model        ${session.model}${session.servedBy.some((m) => m !== session.model) ? ` (served by ${session.servedBy.join(", ")})` : ""}, effort ${effort}`,
    );
    console.log(
      `tokens       ${String(session.usage.input)} in, ${String(session.usage.output)} out; ${String(Date.now() - startedAt)} ms`,
    );
    if (args.get("no-keep") !== "true") {
      const kept = await keepSession(db, session, Date.now());
      console.log(`kept         ${kept.answerId}`);
    }
  } else if (command === "show") {
    const id = positional[0];
    if (id === undefined) throw new Error("show needs an answer id");
    const doc = await repo.findById(id);
    if (doc === null) throw new Error(`no answer ${id}`);
    console.log(`Q (as of ${doc.asOf}): ${doc.question}\n`);
    console.log(doc.rendered);
    console.log("");
    console.log(showAudit(auditAnswer(doc)));
  } else {
    const docs = await repo.recent(Number(args.get("limit") ?? "20"));
    for (const d of docs) {
      const a = auditAnswer(d);
      console.log(
        `${d.answerId}  ${d.asOf}  ${d.verdict.padEnd(11)} ${a.intact && a.verdictHolds && a.renderedHolds ? "holds" : "FAILS"}  ${d.question.slice(0, 70)}`,
      );
    }
    console.log(`${String(docs.length)} answer(s) audited`);
  }
} finally {
  await client.close();
}
