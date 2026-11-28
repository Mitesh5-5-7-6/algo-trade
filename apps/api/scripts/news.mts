/**
 * The news and day-context pipeline, by hand (operator decision 2026-11-28).
 *
 *   node --env-file=<env> scripts/news.mts <command> [options]
 *
 *   collect                   one pass of every feed now: the four general
 *                             feeds, then one Google News query per
 *                             heavyweight, 2 s apart
 *   overnight [--backfill]    the US overnight moves from Yahoo's chart JSON:
 *                             two years with --backfill (or when none are
 *                             stored), the last five days otherwise
 *   read [--date=YYYY-MM-DD]  the morning read of the headlines for a date
 *                             (default today, IST), taken again if one exists
 *   context [--date=…]        build and print the date's day context
 *
 * Every command takes [--db=neelkanth_research] [--dns=1.1.1.1] and loads the
 * event calendar first (idempotent).
 *
 * MONGO_URI names the cluster; --db wins over the database it names, and
 * anything but neelkanth_research or a scratch neelkanth_it_* or
 * neelkanth_ci_* database is refused before anything connects. `read` needs the model:
 * AGENT_PROVIDER (openai, deepseek or gemini), AGENT_MODEL and that
 * provider's key — and refuses to use them beside a broker or production
 * secret, so run it with the agent's env file plus MONGO_URI, never with
 * .env.local alone:
 *
 *   node --env-file=../../.env.agent.local scripts/news.mts read \
 *     --db=neelkanth_research --dns=1.1.1.1
 *
 * Headlines are titles and links only; a key is never printed.
 *
 * Runs the BUILT code: `pnpm build` first.
 */
import {
  researchDatabaseProblem,
  loadResearchAi,
} from "../dist/research-api/environment.js";

const [command, ...rest] = process.argv.slice(2);
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
if (!["collect", "overnight", "read", "context"].includes(command ?? ""))
  throw new Error(
    "usage: news.mts collect | overnight [--backfill] | read [--date=YYYY-MM-DD] | context [--date=YYYY-MM-DD]  [--db=neelkanth_research] [--dns=1.1.1.1]",
  );
const date = args.get("date");
if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date))
  throw new Error(`--date is an IST date, YYYY-MM-DD; got "${date}"`);

// The model before anything connects: a malformed provider is refused here.
const ai = loadResearchAi(process.env);
if (ai.forbidden.length > 0)
  console.error(
    `WARNING: ${ai.note ?? "AI read disabled"} — the morning read will not call a model.`,
  );

const dns = await import("node:dns");
const { MongoClient } = await import("mongodb");
const { istDateKey } = await import("@neelkanth/core");
const { NewsService } = await import("../dist/research-api/news/service.js");

const resolvers = (args.get("dns") ?? "").split(",").filter(Boolean);
if (resolvers.length > 0) dns.setServers(resolvers);
const uri = process.env["MONGO_URI"];
if (!uri) throw new Error("MONGO_URI is not set");
const client = new MongoClient(uri);
const db = client.db(args.get("db"));
const problem = researchDatabaseProblem(db.databaseName);
if (problem !== null) throw new Error(problem);

await client.connect();
try {
  const news = new NewsService({
    db,
    now: () => Date.now(),
    ai,
    onError: (error, context) => {
      console.error(
        `error ${JSON.stringify(context)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
  const added = await news.prepare();
  console.log(`database     ${db.databaseName}`);
  console.log(`calendar     ${String(added)} event(s) added`);
  const day = date ?? istDateKey(Date.now());

  if (command === "collect") {
    const results = [
      ...(await news.collectGeneral()),
      ...(await news.collectHeavyweights()),
    ];
    for (const r of results)
      console.log(
        `${r.feed.padEnd(34)} ${r.read === null ? "FAILED" : `${String(r.read).padStart(3)} read, ${String(r.kept).padStart(3)} new`}`,
      );
    console.log(
      `total        ${String(results.reduce((n, r) => n + r.kept, 0))} new headline(s); ${String(results.filter((r) => r.read === null).length)} feed(s) failed`,
    );
  } else if (command === "overnight") {
    const r = await news.updateOvernight({
      backfill: args.get("backfill") === "true",
    });
    console.log(
      `overnight    range ${r.range}: ${String(r.fetched)} move(s) fetched, ${String(r.added)} new`,
    );
  } else if (command === "read") {
    console.log(
      `model        ${ai.ai === null ? `none — ${ai.note ?? ""}` : `${ai.ai.provider} ${ai.ai.model}`}`,
    );
    const read = await news.morningRead(day, { force: true });
    if (read !== null) {
      console.log(
        `read         ${day}: ${String(read.headlinesRead)} headline(s) read`,
      );
      for (const f of read.flags)
        console.log(
          `flag         ${f.kind} (${String(f.tone)}) ${f.detail} [${f.headlineIds.join(", ")}]`,
        );
      for (const t of read.stockTone)
        console.log(
          `tone         ${t.symbol} ${String(t.tone)} [${t.headlineIds.join(", ")}]`,
        );
      for (const n of read.notes) console.log(`note         ${n}`);
    }
  } else {
    console.log(JSON.stringify(await news.context(day), null, 2));
  }
} finally {
  await client.close();
}
