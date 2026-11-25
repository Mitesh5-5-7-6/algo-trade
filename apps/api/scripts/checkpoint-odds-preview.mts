/**
 * Preview the three-part target's odds table (PLAN.md 14.17) on the stored
 * research bars, exactly as the research service builds it. Reads only.
 *
 *   pnpm --filter @neelkanth/api build
 *   node --env-file=../../.env.local scripts/checkpoint-odds-preview.mts
 */
import dns from "node:dns";
import { MongoClient } from "mongodb";
import { istDateKey } from "@neelkanth/core";
import { loadCandlesBefore } from "../dist/odds/store.js";
import { buildCheckpointOdds } from "../dist/odds/checkpoint-odds.js";

dns.setServers(["1.1.1.1"]);
const uri = process.env.MONGO_URI;
if (uri === undefined) throw new Error("MONGO_URI is not set");
const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db("neelkanth_research");
  const now = Date.now();
  const bars = await loadCandlesBefore(
    db,
    ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX"],
    "5m",
    istDateKey(now),
    now - 180 * 86_400_000,
  );
  const started = Date.now();
  const table = buildCheckpointOdds(bars, now);
  console.log(
    `bars ${String(bars.length)}, sessions ${String(table.sessions)}, rows ${String(table.rows.length)}, built in ${String(Date.now() - started)} ms`,
  );
  for (const r of table.rows)
    if (r.movePct === 0.003 || r.movePct === 0.002)
      console.log(
        r.underlying.replace("NSE:", "").padEnd(16),
        r.direction.padEnd(4),
        `from ${String(9 + Math.floor((15 + r.fromMinute) / 60)).padStart(2, "0")}:${String((15 + r.fromMinute) % 60).padStart(2, "0")}`,
        `move ${(r.movePct * 100).toFixed(1)}%`,
        `back ${String(r.back)}`,
        `samples ${String(r.samples).padStart(5)}`,
        `chance ${(r.chance * 100).toFixed(0)}%`,
      );
} finally {
  await client.close();
}
