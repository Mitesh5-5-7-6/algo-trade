/**
 * Research every complete week, month and quarter (Phase 9, 9.5).
 *
 *   node --env-file=../../.env.local scripts/periodic-research.mts \
 *     --symbols=NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX \
 *     --from=2025-09-29 [--to=<today>] [--periods=WEEK,MONTH,QUARTER] \
 *     (--calendar-file=nse-2025-26.json | --calendar=settings) \
 *     [--recompute-stale] [--db=neelkanth_research] [--dns=1.1.1.1]
 *
 * Run after daily-research.mts: it reads the daily reports, and adds only the
 * windows that have closed since. A calendar is required (design D1): a file
 * of the form { "holidays": [...], "specialSessions": [...], "source": "..." },
 * or the global settings' marketHolidays. With none, every holiday would be
 * filed as a gap — refused rather than guessed (finding F1). Reads and writes
 * `research_reports`, nothing else, in the research or a scratch database.
 *
 * Runs the BUILT code: `pnpm build` first.
 */
import dns from "node:dns";
import { readFileSync } from "node:fs";
import { MongoClient } from "mongodb";
import { DEFAULT_GLOBAL_SETTINGS } from "@neelkanth/db";
import { istDateKey } from "@neelkanth/core";
import { runPeriodicResearch } from "../dist/research/periodic-store.js";
import type { Period, TradingCalendar } from "../dist/research/windows.js";

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
function required(name: string): string {
  const value = args.get(name);
  if (value === undefined || value === "true")
    throw new Error(`--${name}=<value> is required`);
  return value;
}
const list = (name: string): string[] =>
  (args.get(name) ?? "").split(",").filter(Boolean);

const WRITABLE = /^(neelkanth_research|neelkanth_(it|ci)_.+)$/;
const resolvers = list("dns");
if (resolvers.length > 0) dns.setServers(resolvers);
const uri = process.env["MONGO_URI"];
if (!uri) throw new Error("MONGO_URI is not set");
const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(args.get("db"));
  if (!WRITABLE.test(db.databaseName))
    throw new Error(
      `refusing to write research to "${db.databaseName}": only neelkanth_research or a scratch neelkanth_it_*/neelkanth_ci_* database (D6)`,
    );

  let calendar: TradingCalendar;
  const file = args.get("calendar-file");
  if (file !== undefined) {
    const raw = JSON.parse(
      readFileSync(file, "utf8"),
    ) as Partial<TradingCalendar>;
    calendar = {
      holidays: raw.holidays ?? [],
      specialSessions: raw.specialSessions ?? [],
      source: raw.source ?? `file:${file}`,
    };
  } else if (args.get("calendar") === "settings") {
    const settings = await client
      .db()
      .collection("settings")
      .findOne({ scope: "global" });
    const holidays =
      (settings?.["marketHolidays"] as string[] | undefined) ?? [];
    if (holidays.length === 0)
      throw new Error(
        "the global settings hold no marketHolidays (design finding F1): every holiday would be filed as a gap. Pass --calendar-file with the exchange's published calendar.",
      );
    calendar = { holidays, specialSessions: [], source: "settings:global" };
  } else
    throw new Error(
      "a trading calendar is required: --calendar-file=<json> or --calendar=settings (design D1)",
    );

  const now = Date.now();
  const startedAt = Date.now();
  const out = await runPeriodicResearch(db, {
    periods: (args.get("periods")?.split(",") ?? [
      "WEEK",
      "MONTH",
      "QUARTER",
    ]) as Period[],
    symbols: list("symbols"),
    fromDate: required("from"),
    toDate: args.get("to") ?? istDateKey(now),
    calendar,
    close: DEFAULT_GLOBAL_SETTINGS.marketHours.close,
    now,
    recomputeStale: args.get("recompute-stale") === "true",
  });
  console.log(`database     ${db.databaseName}`);
  console.log(
    `calendar     ${calendar.source}: ${String(calendar.holidays.length)} holidays, ${String(calendar.specialSessions.length)} special sessions`,
  );
  console.log(
    `reported     ${String(out.reported.length)}${out.reported.length > 0 ? `: ${out.reported.join(", ")}` : ""}`,
  );
  console.log(
    `recomputed   ${String(out.recomputed.length)}${out.recomputed.length > 0 ? `: ${out.recomputed.join(", ")}` : ""}`,
  );
  console.log(`current      ${String(out.current)}`);
  console.log(`incomplete   ${out.incomplete.join(", ") || "-"}`);
  console.log(`took         ${String(Date.now() - startedAt)} ms`);
} finally {
  await client.close();
}
