/**
 * The pre-open F&O scan (Phase 18, task 18.5).
 *
 * Every F&O underlying, judged on its last daily bar before the scan day by
 * the Phase 5 detectors: each one a candidate with the conditions that held,
 * or a rejection with its reason — never a signal (design §7.1 D2, D3).
 *
 *   node --env-file=../../.env.local scripts/scan.mts --date=2026-11-17 \
 *     [--min-days-to-expiry=2] [--calendar=scripts/calendars/nse-2025-26.json] \
 *     [--fo=NSE_FO.csv --cm=NSE_CM.csv] [--all] \
 *     [--db=neelkanth_research] [--dns=1.1.1.1] [--dry-run]
 *
 * Reads the broker's public symbol files (fetched, or --fo/--cm), and
 * `candles` at the daily interval strictly before --date; writes one
 * `strategy_experiments` document, `kind: "SCAN"`, unless --dry-run. It never
 * calls the broker with a token — daily bars are the backfill's job
 * (`backfill-candles.mts --interval=1d`).
 *
 * Any database but the research one or a scratch one is refused before
 * anything connects or the scan code loads: `refusing "<name>": …`.
 *
 * Runs the BUILT code: `pnpm build` first.
 */
import dns from "node:dns";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { MongoClient } from "mongodb";

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

// The research database or a scratch one, nothing else — decided from the
// names alone, before connecting (design §7.1 D8). Naming a database does not
// connect; --db wins over the one MONGO_URI names.
const RESEARCH = /^(neelkanth_research|neelkanth_(it|ci)_.+)$/;
const uri = process.env["MONGO_URI"];
if (!uri) throw new Error("MONGO_URI is not set");
const client = new MongoClient(uri);
const db = client.db(args.get("db"));
if (!RESEARCH.test(db.databaseName))
  throw new Error(
    `refusing "${db.databaseName}": the scan reads and writes only neelkanth_research or a scratch neelkanth_it_*/neelkanth_ci_* database`,
  );
const { scanFromStore, fetchSymbolFiles } =
  await import("../dist/scanner/store.js");

const date = args.get("date");
if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date))
  throw new Error(
    `--date is the IST trading day the scan is for, YYYY-MM-DD; got "${String(date)}"`,
  );
const minDays = Number(args.get("min-days-to-expiry") ?? "2");
if (!Number.isInteger(minDays) || minDays < 0)
  throw new Error("--min-days-to-expiry is a whole number of days");
const calendarPath =
  args.get("calendar") ?? "scripts/calendars/nse-2025-26.json";
const calendar = JSON.parse(readFileSync(calendarPath, "utf8")) as {
  holidays: string[];
  specialSessions?: string[];
};
const foPath = args.get("fo");
const cmPath = args.get("cm");
if ((foPath === undefined) !== (cmPath === undefined))
  throw new Error("--fo and --cm go together");
const dryRun = args.get("dry-run") === "true";
const all = args.get("all") === "true";

const resolvers = list("dns");
if (resolvers.length > 0) dns.setServers(resolvers);

const line = (label: string, value: string): void => {
  console.log(`${label.padEnd(15)}${value}`);
};
const ist = (ts: number): string =>
  new Date(ts + 19_800_000).toISOString().slice(0, 10);
const short = (n: number): string =>
  Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2);

const files =
  foPath !== undefined && cmPath !== undefined
    ? { fo: readFileSync(foPath, "utf8"), cm: readFileSync(cmPath, "utf8") }
    : await fetchSymbolFiles();

await client.connect();
try {
  const experimentId = `scan_${randomUUID()}`;
  const { run, manifest, saved } = await scanFromStore(db, {
    scanDate: date,
    files,
    minDaysToExpiry: minDays,
    holidays: new Set(calendar.holidays),
    specialSessions: new Set(calendar.specialSessions ?? []),
    experimentId,
    createdAt: Date.now(),
    save: !dryRun,
  });
  const r = run.result;

  line("database", db.databaseName);
  line(
    "scan",
    `${r.scanDate}, before the open — judged on the daily bars of ${r.dataDate}`,
  );
  line(
    "universe",
    `${String(r.counts.members)} F&O underlyings, ${String(r.counts.universeRejected)} left out; contracts expiring within ${String(manifest.minDaysToExpiry)} day(s) passed over`,
  );
  for (const u of r.universeRejected)
    console.log(`               left out ${u.underlying}: ${u.detail}`);
  for (const [i, c] of r.conditions.entries())
    line(
      i === 0 ? "conditions" : "",
      `${c.patternId} ${c.detectorVersion} — ${c.definition}`,
    );
  line("status", r.status);
  for (const reason of r.partialBecause)
    console.log(`               ${reason}`);

  line("candidates", String(r.counts.candidates));
  for (const c of r.candidates) {
    const held = c.held
      .map(
        (h) =>
          `${h.patternId} ${h.direction} (${Object.entries(h.evidence)
            .map(([k, v]) => `${k} ${short(v)}`)
            .join(", ")})`,
      )
      .join("; ");
    console.log(
      `  ${c.underlying.padEnd(12)} ${c.bias.padEnd(8)} close ${short(c.close).padStart(9)}  ${c.future}  lot ${String(c.lotSize)}  bar ${ist(c.dataTime)}`,
    );
    console.log(`               ${held}`);
  }

  const n = r.counts.rejected;
  line(
    "rejected",
    `${String(n.NO_CONDITION)} no condition held, ${String(n.NOT_JUDGEABLE)} could not be judged, ${String(n.STALE_DATA)} stale data, ${String(n.NO_BARS)} no bars`,
  );
  for (const x of r.rejected) {
    if (x.reason === "NO_CONDITION" && !all) continue;
    console.log(
      `  ${x.underlying.padEnd(12)} ${x.reason.padEnd(13)} ${x.detail}`,
    );
  }
  if (!all && n.NO_CONDITION > 0)
    console.log(
      `               (--all lists the ${String(n.NO_CONDITION)} with no condition held, each with every condition's verdict)`,
    );

  line(
    "limits",
    "Candidates, never signals: a candidate carries no entry, stop or size, must still pass a strategy's own rules and the Risk Engine, and nothing the scan writes is read by the order path.",
  );
  console.log(
    "               Daily bars only: a structure completed at yesterday's close, not today's open. The ban list, OI and price band are not checked yet (18.4).",
  );
  line("fingerprint", run.fingerprint);
  line(
    "kept",
    dryRun
      ? "nothing (dry run)"
      : saved
        ? `strategy_experiments ${experimentId}`
        : "NOT kept — the save was refused",
  );
} finally {
  await client.close();
}
