import dns from "node:dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);
import { MongoClient } from "mongodb";
import Redis from "ioredis";

const MONGO_URI = process.env.MONGO_URI;
const REDIS_URL = process.env.REDIS_URL;

const out = (label, value) =>
  console.log(label.padEnd(34), typeof value === "string" ? value : JSON.stringify(value));

const mongo = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
await mongo.connect();
const db = mongo.db();
console.log("=== MONGO ===  db:", db.databaseName);

const settings = await db.collection("settings").findOne({});
out("settings.tradingEnabled", settings?.tradingEnabled);
out("settings.marketHours", settings?.marketHours);
out("settings.capitalAllocation", settings?.capitalAllocation);
out("settings.globalRiskLimits", settings?.globalRiskLimits);

const strategies = await db.collection("strategies").find({}).toArray();
out("strategies TOTAL", strategies.length);
out("strategies ENABLED", strategies.filter((s) => s.enabled).length);
for (const s of strategies) {
  console.log("   -", s.strategyId, "| type:", s.type, "| enabled:", s.enabled, "| symbols:", JSON.stringify(s.symbols));
}

for (const c of ["signals", "risk_logs", "orders", "positions", "candles", "market_ticks"]) {
  out(`count(${c})`, await db.collection(c).countDocuments());
}

const lastSignals = await db.collection("signals").find({}).sort({ ts: -1 }).limit(5).toArray();
console.log("--- last 5 signals ---");
for (const s of lastSignals) console.log("   ", new Date(s.ts).toISOString(), s.strategyId, s.symbol, s.side, "conf", s.confidence, "|", s.reason);

const lastRisk = await db.collection("risk_logs").find({}).sort({ ts: -1 }).limit(5).toArray();
console.log("--- last 5 risk logs ---");
for (const r of lastRisk) console.log("   ", new Date(r.ts).toISOString(), r.decision, r.failedCheck ?? "", "|", r.reason ?? "");

const lastOrders = await db.collection("orders").find({}).sort({ createdAt: -1 }).limit(10).toArray();
console.log("--- last 10 orders ---");
for (const o of lastOrders) console.log("   ", new Date(o.createdAt).toISOString(), o.orderId, o.symbol, o.side, o.qty, o.status, o.mode, "|", o.rejectReason ?? "");

const lastCandles = await db.collection("candles").find({}).sort({ ts: -1 }).limit(3).toArray();
console.log("--- last 3 candles ---");
for (const c of lastCandles) console.log("   ", new Date(c.ts).toISOString(), c.symbol, c.interval, "O", c.open, "C", c.close);

const tokens = await db.collection("broker_tokens").find({}).toArray();
console.log("--- broker tokens ---");
for (const t of tokens) console.log("   user:", t.userId, "expiresAt:", t.expiresAt ? new Date(t.expiresAt).toISOString() : "?", "| expired:", t.expiresAt <= Date.now());

const users = await db.collection("users").find({}).project({ userId: 1, email: 1 }).toArray();
out("users", users.length);

await mongo.close();

console.log("\n=== REDIS ===");
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, connectTimeout: 8000 });
const hotSession = await redis.get("hot:session");
out("RAW hot:session", hotSession === null ? "(missing)" : hotSession);
if (hotSession !== null) {
  let parsed;
  try { parsed = JSON.parse(hotSession); } catch { parsed = "<unparseable>"; }
  out("  JSON.parse(hot:session)", parsed);
  out("  .phase (what PaperBroker reads)", parsed?.phase);
  out("  => readSessionOpen() returns", parsed?.phase === "open");
}
const priceKeys = await redis.keys("hot:price:*");
out("hot:price:* keys", priceKeys.length);
for (const k of priceKeys.slice(0, 10)) console.log("   ", k, "=", await redis.get(k));
const indKeys = await redis.keys("hot:indicators:*");
out("hot:indicators:* keys", indKeys.length);
for (const k of indKeys.slice(0, 5)) console.log("   ", k, "=", (await redis.get(k))?.slice(0, 160));
out("webhooks:fyers:inbox depth", await redis.llen("webhooks:fyers:inbox"));
await redis.quit();
