import dns from "node:dns";
import fs from "node:fs";
dns.setServers(["8.8.8.8", "1.1.1.1"]);
import { MongoClient } from "mongodb";

const APPLY = process.argv.includes("--apply");
const bi = process.argv.indexOf("--backup");
const BACKUP = bi === -1 ? undefined : process.argv[bi + 1];

// Mirrors NormalizedSymbol in apps/api/src/control-plane/routes.ts
const VALID = /^[A-Z]{2,6}:[A-Za-z0-9][A-Za-z0-9._&-]*$/;
const clean = (s) => String(s).replace(/^["'[\]]+|["'[\]]+$/g, "").trim().toUpperCase();

const mongo = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
await mongo.connect();
const col = mongo.db().collection("strategies");
const docs = await col.find({}).toArray();

if (BACKUP) {
  fs.writeFileSync(BACKUP, JSON.stringify(docs, null, 2));
  console.log("backup written:", BACKUP, `(${docs.length} docs)`);
}

let changed = 0;
for (const d of docs) {
  const before = d.symbols ?? [];
  const after = before.map(clean);
  const same = before.length === after.length && before.every((v, i) => v === after[i]);
  const bad = after.filter((s) => !VALID.test(s));

  console.log(`\n${d.strategyId}  (${d.type}, enabled=${d.enabled})`);
  console.log("  before:", JSON.stringify(before));
  console.log("  after :", JSON.stringify(after));
  if (bad.length > 0) {
    console.log("  !! STILL INVALID after cleaning:", JSON.stringify(bad), "- SKIPPED");
    continue;
  }
  if (same) {
    console.log("  (no change needed)");
    continue;
  }
  changed++;
  if (APPLY) {
    await col.updateOne({ _id: d._id }, { $set: { symbols: after } });
    console.log("  -> UPDATED");
  } else {
    console.log("  -> would update (dry run)");
  }
}

console.log(`\n${APPLY ? "APPLIED" : "DRY RUN"}: ${changed} strategy document(s) ${APPLY ? "updated" : "would change"}`);
await mongo.close();
