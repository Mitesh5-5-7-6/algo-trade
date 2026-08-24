import dns from "node:dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);
import { MongoClient } from "mongodb";

const mongo = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
await mongo.connect();
const db = mongo.db();

// What each built-in strategy actually needs before it can decide.
const NEEDS = {
  EMA_CROSSOVER: (p) => ({
    interval: p.interval ?? "5m",
    bars: Math.max(p.slow ?? 21, p.fast ?? 9),
    why: `EMA(${p.slow ?? 21}) seeds from ${p.slow ?? 21} closes`,
  }),
  RSI: (p) => ({
    interval: p.interval ?? "5m",
    bars: (p.period ?? 14) + 1,
    why: `RSI(${p.period ?? 14}) needs period+1 bars`,
  }),
  ORB: (p) => ({
    interval: p.interval ?? "5m",
    bars: p.openingRangeMinutes ? Math.ceil(p.openingRangeMinutes / 5) : 3,
    why: "opening range must complete",
  }),
};

const strategies = await db.collection("strategies").find({ enabled: true }).toArray();

console.log("=== CANDLE COVERAGE PER (symbol, interval) ===");
const agg = await db.collection("candles").aggregate([
  { $group: { _id: { symbol: "$symbol", interval: "$interval" }, n: { $sum: 1 }, first: { $min: "$ts" }, last: { $max: "$ts" } } },
  { $sort: { "_id.symbol": 1, "_id.interval": 1 } },
]).toArray();
for (const a of agg) {
  const mins = Math.round((a.last - a.first) / 60000);
  console.log(
    `  ${a._id.symbol.padEnd(20)} ${a._id.interval.padEnd(4)} bars=${String(a.n).padStart(3)}  ` +
    `${new Date(a.first).toISOString().slice(11,16)}→${new Date(a.last).toISOString().slice(11,16)} UTC (${mins}m span)`
  );
}
if (agg.length === 0) console.log("  (none)");

console.log("\n=== READINESS PER STRATEGY ===");
for (const s of strategies) {
  const need = NEEDS[s.type]?.(s.params ?? {}) ?? { interval: "?", bars: NaN, why: "unknown type" };
  console.log(`\n  ${s.type}  (${s.strategyId})`);
  console.log(`    params        : ${JSON.stringify(s.params)}`);
  console.log(`    decides on    : ${need.interval} candles`);
  console.log(`    needs         : ${need.bars} bars — ${need.why}`);
  for (const sym of s.symbols) {
    const row = agg.find((a) => a._id.symbol === sym && a._id.interval === need.interval);
    const have = row?.n ?? 0;
    const ready = have >= need.bars;
    const shortfallMin = ready ? 0 : (need.bars - have) * (need.interval === "1m" ? 1 : 5);
    console.log(
      `      ${sym.padEnd(20)} have ${String(have).padStart(3)}/${need.bars}  ` +
      (ready ? "\x1b[32mREADY\x1b[0m" : `\x1b[31mNOT READY\x1b[0m — needs ~${shortfallMin} more minutes of feed`)
    );
  }
}

console.log("\n=== WHAT THE PIPELINE PRODUCED ===");
for (const c of ["candles", "signals", "risk_logs", "orders", "positions"]) {
  console.log(`  ${c.padEnd(12)} ${await db.collection(c).countDocuments()}`);
}
await mongo.close();
