/**
 * PLAN.md 14.24, operator decisions 2026-11-28 — run ONCE, after the API with
 * `minDaysToExpiry` and OPEN_DRIVE is deployed. A dry run unless --apply.
 *
 *   node --env-file=../../.env.local scripts/apply-payoff-fix.mts            # show
 *   node --env-file=../../.env.local scripts/apply-payoff-fix.mts --apply    # write
 *
 * 1. Every option strategy buys one strike in the money (strikeOffset -1) on
 *    an expiry at least 5 days away (minDaysToExpiry 5). Their premium stops
 *    and targets are scaled by 0.7 so the INDEX distance stays about where it
 *    was: an ITM option on a later expiry costs ~1.7x the near ATM premium at
 *    delta ~0.6 instead of 0.5, and pct x premium / delta is what the index
 *    must move. An approximation — paper will show how it lands.
 * 2. Two OPEN_DRIVE experiments, NIFTY and BANKNIFTY, ₹1,00,000 each, created
 *    enabled, from the NIFTY momentum strategy's own record as the template.
 *
 * The running process reads strategy configs when it enables them: the
 * change takes effect at its next start (a deploy, or a restart).
 * Idempotent: a strategy already carrying minDaysToExpiry is left alone, and
 * an experiment that exists is not created twice.
 */
import dns from "node:dns";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";

dns.setServers(["1.1.1.1"]);
const APPLY = process.argv.includes("--apply");
const OPTION_TYPES = new Set([
  "INDEX_OPTION_MOMENTUM",
  "INDEX_OPTION_FLOW_BREAKOUT",
  "INDEX_OPTION_SENTIMENT_FADE",
  "INDEX_OPTION_PCR_OI",
  "OPTION_MOMENTUM_SCALPER",
]);
const SCALE = 0.7;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

const client = new MongoClient(process.env.MONGO_URI ?? "");
await client.connect();
try {
  const strategies = client.db("neelkanth_paper").collection("strategies");
  const all = await strategies.find({}).toArray();
  console.log(APPLY ? "APPLYING" : "DRY RUN (add --apply to write)");

  for (const s of all) {
    if (!OPTION_TYPES.has(String(s.type))) continue;
    const p = (s.params ?? {}) as Record<string, unknown>;
    if (typeof p.minDaysToExpiry === "number" && p.minDaysToExpiry > 0) {
      console.log(`  = ${String(s.name)}: already set, left alone`);
      continue;
    }
    const next = {
      ...p,
      strikeOffset: -1,
      minDaysToExpiry: 5,
      ...(typeof p.stopLossPct === "number" ? { stopLossPct: round3(p.stopLossPct * SCALE) } : {}),
      ...(typeof p.targetPct === "number" ? { targetPct: round3(p.targetPct * SCALE) } : {}),
    };
    console.log(
      `  ~ ${String(s.name)}: strikeOffset ${String(p.strikeOffset ?? 0)} → -1, minDaysToExpiry → 5, stop ${String(p.stopLossPct)} → ${String(next.stopLossPct)}, target ${String(p.targetPct)} → ${String(next.targetPct)}`,
    );
    if (APPLY)
      await strategies.updateOne({ _id: s._id }, { $set: { params: next, updatedAt: Date.now() } });
  }

  const template = all.find((s) => s.type === "INDEX_OPTION_MOMENTUM" && (s.params as { underlying?: string } | undefined)?.underlying === "NIFTY");
  if (template === undefined) throw new Error("no NIFTY INDEX_OPTION_MOMENTUM record to copy the experiment from");
  for (const [underlying, symbol, name] of [
    ["NIFTY", "NSE:NIFTY50-INDEX", "NIFTY Open-Drive (experiment)"],
    ["BANKNIFTY", "NSE:NIFTYBANK-INDEX", "BANKNIFTY Open-Drive (experiment)"],
  ] as const) {
    if (all.some((s) => s.name === name)) {
      console.log(`  = ${name}: exists, left alone`);
      continue;
    }
    const { _id: _ignored, ...rest } = template;
    const now = Date.now();
    const doc = {
      ...rest,
      strategyId: `str_${randomUUID()}`,
      type: "OPEN_DRIVE",
      name,
      params: { underlying },
      symbols: [symbol],
      enabled: true,
      allocatedCapital: 100_000,
      createdAt: now,
      updatedAt: now,
    };
    console.log(`  + ${name}: OPEN_DRIVE on ${symbol}, ₹1,00,000, enabled`);
    if (APPLY) await strategies.insertOne(doc);
  }
} finally {
  await client.close();
}
