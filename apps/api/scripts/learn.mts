/**
 * The learning system's judge, run by hand (PLAN.md 14.27). The research
 * service runs the same judge every weekday after the close.
 *
 *   node --env-file=../../.env.local scripts/learn.mts [--save] [--db=neelkanth_research] [--dns=1.1.1.1]
 *
 * Replays the live Momentum rule on the stored 5-minute index bars, attaches
 * each past signal's conditions (heavyweight stocks, the calendar, the US
 * overnight, the morning reads kept so far), and judges the fixed menu of
 * lessons on data each did not learn from. A dry run unless --save, which
 * writes the verdicts to the research database's `lessons`, where the
 * dashboard's Lessons page reads them. Never touches a trading database.
 *
 * Runs the BUILT code: `pnpm build` first.
 */
import dns from "node:dns";
import { MongoClient } from "mongodb";
import { researchDatabaseProblem } from "../dist/research-api/environment.js";
import { runLearner } from "../dist/learning/run-learner.js";

const args = new Map(
  process.argv.slice(2).map((a) => {
    const eq = a.indexOf("=");
    return eq === -1
      ? [a.replace(/^--/, ""), "true"]
      : [a.slice(2, eq), a.slice(eq + 1)];
  }),
);
const resolvers = (args.get("dns") ?? "").split(",").filter(Boolean);
if (resolvers.length > 0) dns.setServers(resolvers);
const dbName = args.get("db") ?? "neelkanth_research";
const problem = researchDatabaseProblem(dbName);
if (problem !== null) throw new Error(problem);

const client = new MongoClient(process.env["MONGO_URI"] ?? "");
await client.connect();
try {
  const save = args.get("save") === "true";
  const result = await runLearner(client.db(dbName), Date.now(), { save });
  for (const line of result.coverage) console.log(line);
  const pct = (x: number | null) =>
    x === null ? "  —  " : `${(x * 100).toFixed(0).padStart(3)}%`;
  const pf = (x: number | null) => (x === null ? " —  " : x.toFixed(2));
  for (const verdict of ["PASSED", "FAILED", "WAITING_FOR_DATA"] as const) {
    const rows = result.lessons.filter((l) => l.verdict === verdict);
    if (rows.length === 0) continue;
    console.log(`\n${verdict} (${String(rows.length)})`);
    for (const l of rows) {
      const t = l.test;
      if (verdict === "WAITING_FOR_DATA") {
        console.log(
          `  ${l.scope.underlying.padEnd(9)} ${l.summary} — ${l.reasons[0] ?? ""}`,
        );
        continue;
      }
      console.log(
        `  ${l.scope.underlying.padEnd(9)} ${l.summary}\n` +
          `            test ${t.from}→${t.to}: all ${String(t.all.n).padStart(3)} win ${pct(t.all.winRate)} PF ${pf(t.all.profitFactor)}` +
          ` | kept ${String(t.kept.n).padStart(3)} win ${pct(t.kept.winRate)} PF ${pf(t.kept.profitFactor)}` +
          ` | blocked ${String(t.blocked.n).padStart(3)} PF ${pf(t.blocked.profitFactor)}` +
          `${l.pValue === null ? "" : ` | p ${l.pValue.toFixed(3)}`}` +
          `\n            learn: all PF ${pf(l.learn.all.profitFactor)} kept PF ${pf(l.learn.kept.profitFactor)} — ${l.reasons.join("; ")}`,
      );
    }
  }
  console.log(
    save ? "\nsaved to lessons" : "\ndry run — add --save to keep the verdicts",
  );
} finally {
  await client.close();
}
