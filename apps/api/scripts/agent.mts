/**
 * The AI research agent (Phase 11, 11.5).
 *
 *   node --env-file=../../.env.agent.local scripts/agent.mts <command> [options]
 *
 *   ask "<question>" [--as-of=YYYY-MM-DD] [--effort=medium|high|xhigh]
 *                    [--no-keep]      answer a research question as of a date
 *   propose "<question>" [--as-of=…]  ask for hypotheses worth testing (Phase 12) —
 *                                     kept with the answer, never registered here
 *   show <answerId>                   a kept answer, and its audit
 *   audit [--limit=20]                audit the most recent kept answers
 *
 * Every command takes [--db=neelkanth_research] [--dns=1.1.1.1].
 *
 * Its own env file — the provider (AGENT_PROVIDER: anthropic, openai or
 * deepseek), its key, the model, and the research MONGO_URI; nothing else
 * (see .env.agent.local.example). It refuses to start beside a broker or
 * production secret, so it cannot be run with .env.local (design D5). It
 * reads the research database only, through six read-only tools, and writes
 * one thing: the answer, to agent_answers (unless --no-keep). Research text
 * is sent to the chosen provider's API (design Q1, D8).
 *
 * Runs the BUILT code: `pnpm build` first.
 */
import {
  assertAgentEnvironment,
  assertResearchDatabase,
} from "../dist/agent/guard.js";

// Before anything else is read or connected (D5).
const agent = assertAgentEnvironment(process.env);

const dns = await import("node:dns");
const { MongoClient } = await import("mongodb");
const { istDateKey } = await import("@neelkanth/core");
const { AgentAnswersRepository } = await import("@neelkanth/db");
const { runResearch } = await import("../dist/agent/loop.js");
const { modelFor } = await import("../dist/agent/provider.js");
const { auditAnswer, keepSession } = await import("../dist/agent/store.js");
const { ToolContext } = await import("../dist/agent/tools.js");
const { proposalCatalog } = await import("../dist/agent/catalog.js");
const { default: Anthropic } = await import("@anthropic-ai/sdk");
const { default: OpenAI } = await import("openai");

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
if (!["ask", "propose", "show", "audit"].includes(command ?? ""))
  throw new Error(
    'usage: agent.mts ask "<question>" | propose "<question>" | show <answerId> | audit',
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

  if (command === "ask" || command === "propose") {
    const asked = positional.join(" ").trim();
    if (asked === "")
      throw new Error(`${command} needs a question: ${command} "…"`);
    // Proposing is asking, with the request made explicit (Phase 12 D1).
    const question =
      command === "propose"
        ? `Propose up to five hypotheses worth testing out of sample, each resting on the evidence — ${asked}`
        : asked;
    const asOf = args.get("as-of") ?? istDateKey(Date.now());
    const effort = (args.get("effort") ?? "high") as
      "medium" | "high" | "xhigh";
    const startedAt = Date.now();
    const tools = new ToolContext(db, asOf);
    // What a proposal may name: the instruments researched up to asOf (D3).
    const symbols = [
      ...new Set((await tools.dailyReports()).map((r) => r.symbol)),
    ];
    const session = await runResearch(
      question,
      tools,
      modelFor(agent, process.env, effort),
      symbols.length === 0 ? {} : { catalog: proposalCatalog(symbols) },
    );
    console.log(session.rendered);
    console.log("");
    console.log(`database     ${db.databaseName}, as of ${asOf}`);
    console.log(
      `session      ${session.status}, ${session.verdict}; ${String(session.turns)} turns, ${String(session.calls.length)} tool calls, ${String(session.corrections)} corrections`,
    );
    console.log(
      `model        ${session.model}${session.servedBy.some((m) => m !== session.model) ? ` (served by ${session.servedBy.join(", ")})` : ""}, ${agent.provider}${agent.provider === "anthropic" ? `, effort ${effort}` : ""}`,
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
} catch (e) {
  // An API error — no credit, a bad key, a rate limit — is reported in one
  // line, not as a stack trace, and the command fails.
  if (e instanceof Anthropic.APIError) {
    const detail = (e.error as { error?: { message?: string } } | undefined)
      ?.error?.message;
    console.error(
      `Anthropic API ${String(e.status)}: ${detail ?? e.message} (request ${e.requestID ?? "—"})`,
    );
  } else if (e instanceof OpenAI.APIError) {
    console.error(
      `${agent.provider} API ${String(e.status)}: ${e.message} (request ${e.requestID ?? "—"})`,
    );
  } else throw e;
  process.exitCode = 1;
} finally {
  await client.close();
}
