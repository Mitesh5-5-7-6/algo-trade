/**
 * The research knowledge base (Phase 10, 10.7).
 *
 *   node --env-file=../../.env.local scripts/knowledge.mts <command> [options]
 *
 *   index        [--dry-run]           index the research database into `documents`
 *   search       [--text=...  — quote a phrase to keep stop words: --text='"gap down"']
 *                [--kinds=DAY,TRADE,...] [--symbols=...]
 *                [--patterns=...] [--strategies=...] [--regimes=...]
 *                [--outcome=WIN] [--from=] [--to=] [--limit=20]
 *   similar      --date=YYYY-MM-DD --symbol=NSE:...-INDEX [--k=5] [--same-symbol]
 *   patterns     [--patterns=...] [--regimes=...] [--symbols=...] [--from=] [--to=]
 *   trades       [--strategies=...] [--patterns=...] [--regimes=...] [--outcome=]
 *   matrix       --pattern=ORB_BREAKOUT [--symbols=...] [--from=] [--to=]
 *   experiments  [--strategies=...] [--patterns=...]
 *
 * Every command takes [--as-of=YYYY-MM-DD] — nothing about a period that
 * ended after it (design D5) — and [--db=neelkanth_research] [--dns=1.1.1.1].
 * Run after the research: `index` reads the research collections and writes
 * `documents` only (D7), in the research or a scratch database; every other
 * command only reads. Read models print JSON, provenance first.
 *
 * Runs the BUILT code: `pnpm build` first.
 */
import dns from "node:dns";
import { MongoClient } from "mongodb";
import { indexResearch } from "../dist/knowledge/indexer.js";
import { searchKnowledge } from "../dist/knowledge/search.js";
import { findSimilarSessions } from "../dist/knowledge/similar.js";
import {
  experimentHistory,
  findPatterns,
  readDailyReports,
  strategyMatrix,
  tradeHistory,
} from "../dist/knowledge/read.js";
import type { KnowledgeKind } from "../dist/knowledge/document.js";

const command = process.argv[2];
const args = new Map(
  process.argv
    .slice(3)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const eq = a.indexOf("=");
      return eq === -1
        ? ([a.slice(2), "true"] as const)
        : ([a.slice(2, eq), a.slice(eq + 1)] as const);
    }),
);
function required(name: string): string {
  const value = args.get(name);
  if (value === undefined || value === "true")
    throw new Error(`--${name}=<value> is required`);
  return value;
}
/** A comma list, or undefined when not given — so an absent facet filters nothing. */
const list = (name: string): string[] | undefined => {
  const v = args.get(name);
  return v === undefined ? undefined : v.split(",").filter(Boolean);
};
const opt = (name: string): string | undefined => args.get(name);
/** Only the keys that were given. */
const given = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;

const COMMANDS = [
  "index",
  "search",
  "similar",
  "patterns",
  "trades",
  "matrix",
  "experiments",
];
if (command === undefined || !COMMANDS.includes(command))
  throw new Error(`a command is required: ${COMMANDS.join(" | ")}`);

const WRITABLE = /^(neelkanth_research|neelkanth_(it|ci)_.+)$/;
const resolvers = list("dns") ?? [];
if (resolvers.length > 0) dns.setServers(resolvers);
const uri = process.env["MONGO_URI"];
if (!uri) throw new Error("MONGO_URI is not set");
const client = new MongoClient(uri);
await client.connect();
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
try {
  const db = client.db(opt("db"));
  const asOf = opt("as-of");
  const scope = given({
    symbols: list("symbols"),
    fromDate: opt("from"),
    toDate: opt("to"),
    asOf,
  });
  const startedAt = Date.now();
  if (command === "index") {
    const dryRun = args.get("dry-run") === "true";
    if (!dryRun && !WRITABLE.test(db.databaseName))
      throw new Error(
        `refusing to index into "${db.databaseName}": only neelkanth_research or a scratch neelkanth_it_*/neelkanth_ci_* database (D7)`,
      );
    const out = await indexResearch(db, { dryRun });
    console.log(
      `database     ${db.databaseName}${dryRun ? " (dry run: nothing written)" : ""}`,
    );
    console.log(`added        ${String(out.added)}`);
    console.log(`replaced     ${String(out.replaced)}`);
    console.log(`unchanged    ${String(out.unchanged)}`);
    console.log(`removed      ${String(out.removed)}`);
    console.log(
      `by kind      ${Object.entries(out.byKind)
        .map(([k, n]) => `${k} ${String(n)}`)
        .join(", ")}`,
    );
    console.log(`took         ${String(Date.now() - startedAt)} ms`);
  } else if (command === "search") {
    const hits = await searchKnowledge(
      db,
      given({
        ...scope,
        text: opt("text"),
        kinds: list("kinds") as KnowledgeKind[] | undefined,
        patterns: list("patterns"),
        strategies: list("strategies"),
        regimes: list("regimes"),
        outcome: opt("outcome"),
        limit: opt("limit") === undefined ? undefined : Number(opt("limit")),
      }),
    );
    for (const h of hits) {
      console.log(
        `${h.score === null ? "" : `[${h.score.toFixed(2)}] `}${h.docId}  (${h.subject.fromDate}..${h.subject.toDate})`,
      );
      console.log(`  ${h.text}`);
    }
    console.log(
      `${String(hits.length)} hit(s)${asOf === undefined ? "" : `, as of ${asOf}`}`,
    );
  } else if (command === "similar") {
    const answer = await findSimilarSessions(
      db,
      given({
        date: required("date"),
        symbol: required("symbol"),
        k: opt("k") === undefined ? undefined : Number(opt("k")),
        asOf,
        sameSymbol: args.get("same-symbol") === "true" ? true : undefined,
      }) as { date: string; symbol: string },
    );
    if (answer === null) throw new Error("that day has no daily report");
    print(answer);
  } else if (command === "experiments") {
    print(
      await experimentHistory(
        db,
        given({
          strategies: list("strategies"),
          patterns: list("patterns"),
          asOf,
        }),
      ),
    );
  } else {
    const reports = await readDailyReports(db, scope);
    if (command === "patterns")
      print(
        findPatterns(
          reports,
          given({
            ...scope,
            patterns: list("patterns"),
            regimes: list("regimes"),
          }),
        ),
      );
    else if (command === "trades")
      print(
        tradeHistory(
          reports,
          given({
            ...scope,
            strategies: list("strategies"),
            patterns: list("patterns"),
            regimes: list("regimes"),
            outcome: opt("outcome") as "WIN" | "LOSS" | "FLAT" | undefined,
          }),
        ),
      );
    else
      print(
        strategyMatrix(reports, { ...scope, patternId: required("pattern") }),
      );
  }
} finally {
  await client.close();
}
