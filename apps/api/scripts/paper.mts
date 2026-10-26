/**
 * Paper validation (Phase 14): the test subject, and each session's report.
 *
 *   node --env-file=../../.env.paper scripts/paper.mts <command> [options]
 *
 *   provision [--symbols=NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX]
 *                       write the test subject — ORB and EMA_CROSSOVER, enabled,
 *                       marked `subject` — unless it is there already; before
 *                       the process starts, which enables strategies at boot
 *   report [--session=2026-10-26] [--dry-run]
 *                       one session (today, IST, by default): its signals,
 *                       orders, Trades, P&L, reconciliation and restarts, and
 *                       its parity against the replay of its own bars; kept
 *                       in paper_session_reports unless --dry-run
 *   reports [--limit=10]
 *                       the latest report of each session, newest first
 *
 *   [--db=neelkanth_paper] [--dns=1.1.1.1]
 *
 * The paper database only — a paper one, or a scratch neelkanth_it_ or _ci_ one,
 * the rule the paper process itself starts under (D2). Writes `strategies`
 * (provision) and `paper_session_reports` (report) only.
 *
 * Runs the BUILT code: `pnpm build` first.
 */
import dns from "node:dns";
import { MongoClient } from "mongodb";
import { istDateKey } from "@neelkanth/core";
import { PaperSessionReportsRepository } from "@neelkanth/db";
import { modeDatabaseProblem } from "../dist/environment.js";
import { provisionSubject } from "../dist/paper/subject.js";
import {
  reportSessionFromStore,
  type PaperSessionReport,
} from "../dist/paper/session-report-store.js";

const [command] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const eq = a.indexOf("=");
      return eq === -1
        ? ([a.slice(2), "true"] as const)
        : ([a.slice(2, eq), a.slice(eq + 1)] as const);
    }),
);
const list = (name: string): string[] =>
  (args.get(name) ?? "").split(",").filter(Boolean);
const COMMANDS = ["provision", "report", "reports"];
if (!COMMANDS.includes(command ?? ""))
  throw new Error(`usage: paper.mts ${COMMANDS.join(" | ")} …`);

const resolvers = list("dns");
if (resolvers.length > 0) dns.setServers(resolvers);
const uri = process.env["MONGO_URI"];
if (!uri) throw new Error("MONGO_URI is not set");
const client = new MongoClient(uri);
await client.connect();

const money = (x: number | null) => (x === null ? "—" : x.toFixed(2));
const time = (ts: number | null) =>
  ts === null
    ? "—"
    : new Date(ts + 5.5 * 3_600_000).toISOString().slice(11, 19);
const mark = (ok: boolean) => (ok ? "✓" : "✗");

function show(r: PaperSessionReport): void {
  const { record, parity } = r;
  console.log(`session      ${r.session}   ${r.clean ? "CLEAN" : "NOT CLEAN"}`);
  console.log(
    `replay       ${r.replay.interval ?? "—"} bars from ${r.replay.fromDate}, ${String(r.replay.bars)} bars, ${r.replay.strategies.map((s) => `${s.strategyId}@${s.version}`).join(", ") || "no strategy"}`,
  );
  console.log(`bars         ${r.replay.barsFingerprint}`);

  console.log(`\nsignals      ${String(record.signals.length)}`);
  for (const s of record.signals)
    console.log(
      `  ${time(s.ts)}  ${s.strategyId.padEnd(22)} ${s.symbol.padEnd(20)} ${s.side.padEnd(4)} @ ${money(s.decisionPrice)}  ${s.risk === null ? "no risk decision" : `${s.risk.decision}${s.risk.failedCheck === null ? "" : ` (${s.risk.failedCheck})`}`}  ${s.reason}`,
    );
  console.log(`\norders       ${String(record.orders.length)}`);
  for (const o of record.orders)
    console.log(
      `  ${time(o.filledAt)}  ${o.symbol.padEnd(20)} ${o.side.padEnd(4)} ${String(o.qty).padStart(5)} ${o.status.padEnd(9)} fill ${money(o.filledPrice)}  decision ${money(o.decisionPrice)}  slippage ${money(o.slippageVsDecision)}  charges ${money(o.charges)}${o.exitReason === null ? "" : `  ${o.exitReason}`}${o.rejectReason === null ? "" : `  refused: ${o.rejectReason}`}`,
    );
  console.log(`\ntrades       ${String(record.trades.length)}`);
  for (const t of record.trades)
    console.log(
      `  ${t.strategyId.padEnd(22)} ${t.symbol.padEnd(20)} ${t.side.padEnd(5)} ${String(t.quantity).padStart(5)}  ${time(t.entryTime)} ${money(t.entryPrice)} → ${time(t.exitTime)} ${money(t.exitPrice)}  ${(t.exitReason ?? t.status).padEnd(15)} net ${money(t.netPnl)}`,
    );
  console.log(
    `\nP&L          gross ${money(record.pnl.gross)}  charges ${money(record.pnl.charges)}  net ${money(record.pnl.net)}  (${String(record.pnl.closedTrades)} closed, ${String(record.pnl.openTrades)} open)`,
  );
  const rec = record.reconciliation;
  console.log(
    `\n${mark(rec.clean)} reconciliation  ${rec.runs.map((run) => `${run.at} ${time(run.ts)} ${run.clean ? "clean" : `${String(run.mismatches)} mismatches`}`).join(", ") || "no run"}${rec.missing.length > 0 ? `  — missing ${rec.missing.join(", ")}` : ""}`,
  );
  console.log(
    `  restarts       ${record.restarts.map(time).join(", ") || "none"}`,
  );
  console.log(`${mark(record.pnl.openTrades === 0)} flat at the close`);
  console.log(
    `${mark(parity.clean)} parity (v${parity.version}, ±${String(parity.tolerance.entryPriceBps)}/${String(parity.tolerance.exitPriceBps)} bps, ${String(parity.tolerance.exitBars)} bar)  paper ${String(parity.compared.paperSignals)} signals / ${String(parity.compared.paperTrades)} trades, replay ${String(parity.compared.replaySignals)} / ${String(parity.compared.replayTrades)}`,
  );
  for (const d of parity.differences)
    console.log(
      `  ${d.kind.padEnd(16)} ${d.key}  ${d.field}: paper ${d.paper} | replay ${d.replay}`,
    );
}

try {
  const db = client.db(args.get("db"));
  const problem = modeDatabaseProblem("paper", db.databaseName);
  if (problem !== null) throw new Error(problem);

  if (command === "provision") {
    const symbols = list("symbols");
    const { created, existing } = await provisionSubject(db, {
      ...(symbols.length > 0 ? { symbols } : {}),
      now: Date.now(),
    });
    for (const c of created)
      console.log(
        `provisioned  ${c.strategyId}: ${c.type} on ${c.symbols.join(", ")}, enabled, subject`,
      );
    for (const c of existing)
      console.log(
        `kept         ${c.strategyId}: already present, ${c.enabled ? "enabled" : "DISABLED"} — left as it is`,
      );
  } else if (command === "report") {
    const session = args.get("session") ?? istDateKey(Date.now());
    const dry = args.get("dry-run") === "true";
    const generatedAt = Date.now();
    const reportId = `psr_${session}_${String(generatedAt)}`;
    const { report, saved } = await reportSessionFromStore(
      db,
      { session, generatedAt },
      dry ? { save: false } : { save: true, reportId },
    );
    show(report);
    console.log(
      `\nkept         ${saved ? reportId : dry ? "no (dry run)" : "no"}`,
    );
  } else {
    const limit = Number(args.get("limit") ?? "10");
    for (const doc of await new PaperSessionReportsRepository(
      db,
    ).latestPerSession(limit)) {
      const r = doc.report as unknown as PaperSessionReport;
      console.log(
        `${doc.session}  ${doc.clean ? "CLEAN    " : "NOT CLEAN"}  ${String(r.record.pnl.closedTrades).padStart(3)} trades  net ${money(r.record.pnl.net).padStart(10)}  ${String(r.parity.differences.length).padStart(3)} differences  restarts ${String(r.record.restarts.length)}  reconciliation ${r.record.reconciliation.clean ? "clean" : "NOT clean"}  ${doc.reportId}`,
      );
    }
  }
} catch (e) {
  // A refusal is the answer, in one line — not a stack trace.
  console.error(`refused: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
