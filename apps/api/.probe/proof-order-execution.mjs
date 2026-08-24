/**
 * CONTROLLED ORDER-EXECUTION PROOF
 *
 * Drives ONE BUY and ONE SELL through the real production pipeline and reports
 * what each stage did. Nothing here is a mock of our own code: it builds the
 * same `startEngineRuntime` the API boots, against the real Redis and the real
 * Mongo, with the real PaperBroker behind the same closures the composition
 * root uses.
 *
 * The ONLY substitution is the market-data source. FYERS is replaced by a tick
 * injector, because the whole point is a *controlled* order: we choose the
 * prices, so we know exactly which bar must produce the cross. Everything
 * downstream of `onData` — normalizer, aggregator, indicators, strategy, risk,
 * order manager, broker, position, PnL — is production code on the production
 * path.
 *
 *   node --env-file=.env.local apps/api/.probe/proof-order-execution.mjs
 *
 * Read-only with respect to your real strategies. It writes rows for one
 * synthetic symbol and deletes them again at the end unless --keep is passed.
 */
import dns from "node:dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]); // this box resolves to 127.0.0.1

import {
  createRedisConnections,
  verifyRedisConnection,
  hotPriceKey,
  hotSessionKey,
} from "@neelkanth/redis";
import { connectMongo } from "@neelkanth/db";
import { createLogger } from "@neelkanth/logger";
import { PaperBroker } from "@neelkanth/broker";
import { startEngineRuntime } from "../dist/engines/runtime.js";

const KEEP = process.argv.includes("--keep");
const VERBOSE = process.argv.includes("--verbose");

const SYMBOL = "NSE:PROOFTEST-EQ";
const STRATEGY_ID = "str_proof_execution";
const INTERVAL = "1m";

/** A Monday inside NSE hours (11:00 IST), so the session reads `open`. */
const MARKET_OPEN_TS = Date.parse("2026-08-24T05:30:00.000Z"); // 11:00 IST
const BAR = 60_000;

/**
 * Closes chosen so EMA(2) crosses EMA(3) upward on bar 5 and downward on
 * bar 7. Bars 1-3 warm both EMAs; bar 4 seeds the previous-EMA pair the cross
 * detector needs. Verified arithmetically below before anything is sent.
 */
const CLOSES = [100, 99, 98, 97, 110, 112, 90];
const CROSS_UP_BAR = 5;
const CROSS_DOWN_BAR = 7;

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const step = (n, s) => console.log(`\n\x1b[1m[${n}] ${s}\x1b[0m`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn()` returns truthy, or throw after `timeoutMs`. */
async function waitFor(label, fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label} (${timeoutMs}ms)`);
    }
    await sleep(100);
  }
}

// ---------------------------------------------------------------------------
// Predict the crossings before touching any infrastructure. If the fixture
// does not actually produce a cross, the run would "pass" by proving nothing.
// ---------------------------------------------------------------------------
function predictCrosses(closes, fast, slow) {
  const emaSeries = (period) => {
    const alpha = 2 / (period + 1);
    let value = null;
    let sum = 0;
    let count = 0;
    return closes.map((c) => {
      if (value === null) {
        sum += c;
        count += 1;
        if (count === period) value = sum / period;
      } else {
        value = alpha * c + (1 - alpha) * value;
      }
      return value;
    });
  };
  const f = emaSeries(fast);
  const s = emaSeries(slow);
  const crosses = [];
  for (let i = 1; i < closes.length; i++) {
    if (f[i] === null || s[i] === null || f[i - 1] === null || s[i - 1] === null)
      continue;
    if (f[i - 1] <= s[i - 1] && f[i] > s[i]) crosses.push({ bar: i + 1, dir: "UP" });
    if (f[i - 1] >= s[i - 1] && f[i] < s[i]) crosses.push({ bar: i + 1, dir: "DOWN" });
  }
  return { f, s, crosses };
}

async function main() {
  console.log("\x1b[1m═══ CONTROLLED ORDER-EXECUTION PROOF ═══\x1b[0m");

  // --- 0. Verify the fixture actually crosses -----------------------------
  step(0, "Verify the price fixture produces the crossings we depend on");
  const { f, s, crosses } = predictCrosses(CLOSES, 2, 3);
  CLOSES.forEach((c, i) => {
    console.log(
      `    bar ${i + 1}  close ${String(c).padStart(4)}  ema2=${f[i] === null ? "—" : f[i].toFixed(3).padStart(8)}  ema3=${s[i] === null ? "—" : s[i].toFixed(3).padStart(8)}`,
    );
  });
  console.log("    crossings:", JSON.stringify(crosses));
  const hasUp = crosses.some((c) => c.bar === CROSS_UP_BAR && c.dir === "UP");
  const hasDown = crosses.some((c) => c.bar === CROSS_DOWN_BAR && c.dir === "DOWN");
  if (!hasUp || !hasDown) {
    throw new Error(
      `fixture does not cross as intended (up@${CROSS_UP_BAR}=${hasUp}, down@${CROSS_DOWN_BAR}=${hasDown}) — the proof would be vacuous`,
    );
  }
  console.log(ok(`    ✓ BUY expected on bar ${CROSS_UP_BAR}, SELL on bar ${CROSS_DOWN_BAR}`));

  // --- 1. Infrastructure ---------------------------------------------------
  step(1, "Connect Redis + Mongo (the same checks the API boots with)");
  const REDIS_URL = process.env.REDIS_URL;
  const MONGO_URI = process.env.MONGO_URI;
  if (!REDIS_URL || !MONGO_URI) throw new Error("REDIS_URL and MONGO_URI must be set");

  const redis = createRedisConnections(REDIS_URL, (e, src) => {
    if (VERBOSE) console.log(dim(`    redis ${src}: ${e.message}`));
  });
  await verifyRedisConnection(redis, REDIS_URL);
  console.log(ok("    ✓ Redis reachable AND writable"));

  // Pub/Sub preflight. The whole fill→position→PnL projection rides on it
  // (Regime B), and a provider that silently drops SUBSCRIBE would look like
  // a pipeline bug rather than a platform limit.
  const gotMessage = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no pub/sub message in 8s")), 8000);
    redis.subscriber.on("message", (ch, msg) => {
      if (ch === "proof:preflight") {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
  await redis.subscriber.subscribe("proof:preflight");
  await redis.publisher.publish("proof:preflight", "ping");
  await gotMessage;
  await redis.subscriber.unsubscribe("proof:preflight");
  console.log(ok("    ✓ Redis Pub/Sub delivers (the projection chain can run)"));

  const mongo = await connectMongo(MONGO_URI);
  console.log(ok(`    ✓ Mongo connected (db: ${mongo.db.databaseName})`));

  // --- 2. Broker: real paper execution, injectable data --------------------
  step(2, "Build the broker exactly as the composition root does in paper mode");
  const paper = new PaperBroker({
    readPrice: async (symbol) => {
      const val = await redis.client.get(hotPriceKey(symbol));
      return val ? JSON.parse(val).ltp : null;
    },
    readSessionOpen: async () => {
      const val = await redis.client.get(hotSessionKey());
      return val ? JSON.parse(val).phase === "open" : false;
    },
  });

  const dataHandlers = [];
  const stateHandlers = [];
  const subscribed = [];
  const broker = {
    // Data side: the tick injector standing in for the FYERS socket.
    connect: async () => {
      for (const h of stateHandlers) h("connected");
    },
    disconnect: async () => {
      for (const h of stateHandlers) h("disconnected");
    },
    subscribe: async (symbols) => {
      subscribed.push(...symbols);
    },
    onData: (cb) => dataHandlers.push(cb),
    onConnectionChange: (cb) => stateHandlers.push(cb),
    // Execution side: the real PaperBroker, real Redis closures.
    execute: (o) => paper.execute(o),
    cancel: (id) => paper.cancel(id),
    status: (id) => paper.status(id),
    onOrderUpdate: (cb) => paper.onOrderUpdate(cb),
  };
  const emitTick = (raw) => {
    for (const h of dataHandlers) h(raw);
  };
  console.log(ok("    ✓ PaperBroker execution + injectable data feed"));

  // --- 3. Start the real runtime ------------------------------------------
  step(3, "Start the production engine runtime");
  const logger = createLogger({
    level: VERBOSE ? "info" : "warn",
    name: "proof",
  });
  const runtime = await startEngineRuntime({
    redis,
    mongo,
    logger,
    broker,
    mode: "paper",
  });
  await broker.connect();
  console.log(ok("    ✓ startEngineRuntime() wired: MarketData → Indicators → Strategy → Risk → Order → Position → PnL"));

  const db = mongo.db;
  const cleanup = async () => {
    if (KEEP) {
      console.log(dim("\n    --keep: proof rows left in place"));
      return;
    }
    await Promise.all([
      db.collection("signals").deleteMany({ strategyId: STRATEGY_ID }),
      db.collection("risk_logs").deleteMany({ strategyId: STRATEGY_ID }),
      db.collection("orders").deleteMany({ strategyId: STRATEGY_ID }),
      db.collection("positions").deleteMany({ strategyId: STRATEGY_ID }),
      db.collection("candles").deleteMany({ symbol: SYMBOL }),
    ]);
    await redis.client.del(hotPriceKey(SYMBOL));
    console.log(dim("\n    proof rows cleaned up"));
  };

  try {
    // --- 4. Session --------------------------------------------------------
    step(4, "Open the session (the gate that used to refuse every paper order)");
    await runtime.syncSession(MARKET_OPEN_TS);
    const rawSession = await redis.client.get(hotSessionKey());
    console.log(`    hot:session raw          : ${rawSession}`);
    console.log(`    runtime session phase    : ${runtime.session().phase}`);
    const brokerSeesOpen = rawSession
      ? JSON.parse(rawSession).phase === "open"
      : false;
    console.log(
      `    PaperBroker readSessionOpen(): ${brokerSeesOpen ? ok("true") : bad("false")}`,
    );
    if (!brokerSeesOpen) {
      throw new Error(
        "hot:session is not readable as open — the Paper Broker will reject every order with 'market is closed'",
      );
    }

    // --- 5. Enable the proof strategy --------------------------------------
    step(5, "Enable a controlled EMA_CROSSOVER on a synthetic symbol");
    await runtime.enableStrategy({
      strategyId: STRATEGY_ID,
      ownerId: "operator",
      name: "Order Execution Proof",
      type: "EMA_CROSSOVER",
      enabled: true,
      status: "active",
      symbols: [SYMBOL],
      params: {
        fast: 2,
        slow: 3,
        interval: INTERVAL,
        quantity: 1,
        targetR: 2,
        allowShort: false,
        swingLookback: 3,
      },
      createdAt: MARKET_OPEN_TS,
      updatedAt: MARKET_OPEN_TS,
    });
    console.log(ok(`    ✓ ${STRATEGY_ID} enabled on ${SYMBOL}`));
    console.log(`    working set now subscribed: ${JSON.stringify(subscribed)}`);

    // --- 6. Feed ticks -----------------------------------------------------
    step(6, "Inject ticks → candles → indicators → strategy → risk → order");
    // Each bar is one tick at its bucket start, plus a boundary-crossing tick
    // to close it. The aggregator closes a bar only when a later bucket opens.
    for (let i = 0; i < CLOSES.length; i++) {
      const ts = MARKET_OPEN_TS + i * BAR + 1000;
      emitTick({
        symbol: SYMBOL,
        ltp: CLOSES[i],
        vol_traded_today: 1000 * (i + 1),
        exch_feed_time: Math.floor(ts / 1000),
      });
      await sleep(250); // let the bus deliver before the next bar
      const orderCount = await db
        .collection("orders")
        .countDocuments({ strategyId: STRATEGY_ID });
      console.log(
        `    bar ${i + 1} close ${String(CLOSES[i]).padStart(4)} → orders so far: ${orderCount}`,
      );
    }
    // One trailing tick in a later bucket so the final bar closes.
    emitTick({
      symbol: SYMBOL,
      ltp: CLOSES[CLOSES.length - 1],
      vol_traded_today: 99_000,
      exch_feed_time: Math.floor((MARKET_OPEN_TS + CLOSES.length * BAR + 1000) / 1000),
    });

    // --- 7. Wait for both orders -------------------------------------------
    step(7, "Wait for the BUY and the SELL to reach a terminal state");
    const orders = await waitFor("2 orders", async () => {
      const rows = await db
        .collection("orders")
        .find({ strategyId: STRATEGY_ID })
        .sort({ createdAt: 1 })
        .toArray();
      return rows.length >= 2 ? rows : null;
    });
    await sleep(1500); // let the position/PnL projection settle

    // --- 8. Report ---------------------------------------------------------
    step(8, "RESULT");
    const signals = await db
      .collection("signals")
      .find({ strategyId: STRATEGY_ID })
      .sort({ ts: 1 })
      .toArray();
    const riskLogs = await db
      .collection("risk_logs")
      .find({ strategyId: STRATEGY_ID })
      .sort({ ts: 1 })
      .toArray();
    const positions = await db
      .collection("positions")
      .find({ strategyId: STRATEGY_ID })
      .toArray();
    const candles = await db.collection("candles").countDocuments({ symbol: SYMBOL });

    console.log(`\n  Candles persisted     : ${candles}`);
    console.log(`  Signals               : ${signals.length}`);
    for (const s of signals) {
      console.log(
        `    ${s.side.padEnd(4)} conf ${s.confidence.toFixed(3)}  ${dim(s.reason)}`,
      );
    }
    console.log(`  Risk decisions        : ${riskLogs.length}`);
    for (const r of riskLogs) {
      const tag = r.decision === "approved" ? ok("approved") : bad(`blocked (${r.failedCheck})`);
      console.log(`    ${tag} ${r.reason ? dim(r.reason) : ""}`);
    }
    console.log(`  Orders                : ${orders.length}`);
    for (const o of orders) {
      const statusTag = o.status === "FILLED" ? ok(o.status) : bad(o.status);
      console.log(
        `    ${o.side.padEnd(4)} qty ${o.qty}  ${statusTag}  @ ${o.filledPrice ?? "—"}  mode=${o.mode}  charges=${o.charges?.toFixed(2) ?? "—"}${o.rejectReason ? bad("  reason: " + o.rejectReason) : ""}`,
      );
    }
    console.log(`  Positions             : ${positions.length}`);
    for (const p of positions) {
      console.log(
        `    ${p.side} ${p.symbol} qty ${p.qty} avg ${p.avgEntryPrice.toFixed(4)} status ${p.status} realized ${p.realizedPnl.toFixed(2)}`,
      );
    }
    console.log(`  Runtime realized PnL  : ${runtime.realizedPnl().toFixed(2)}`);
    console.log(`  Runtime unrealized    : ${runtime.unrealizedPnl().toFixed(2)}`);

    // --- 9. Verdict --------------------------------------------------------
    const buy = orders.find((o) => o.side === "BUY");
    const sell = orders.find((o) => o.side === "SELL");
    const checks = [
      ["candles were produced from ticks", candles > 0],
      ["a BUY signal reached risk", signals.some((s) => s.side === "BUY")],
      ["a SELL signal reached risk", signals.some((s) => s.side === "SELL")],
      ["risk approved both", riskLogs.filter((r) => r.decision === "approved").length >= 2],
      ["a BUY order was placed", Boolean(buy)],
      ["the BUY filled", buy?.status === "FILLED"],
      ["a SELL order was placed", Boolean(sell)],
      ["the SELL filled", sell?.status === "FILLED"],
      ["a position opened and closed", positions.some((p) => p.status === "CLOSED")],
    ];
    console.log("\n\x1b[1m  VERDICT\x1b[0m");
    let allPassed = true;
    for (const [label, passed] of checks) {
      console.log(`    ${passed ? ok("✓") : bad("✗")} ${label}`);
      if (!passed) allPassed = false;
    }
    console.log(
      allPassed
        ? ok("\n  ✓ PROVEN: one BUY and one SELL executed through the production path.")
        : bad("\n  ✗ NOT PROVEN — see the failed checks above."),
    );
    process.exitCode = allPassed ? 0 : 1;
  } finally {
    await cleanup();
    await runtime.shutdown();
    await redis.quit();
    await mongo.close();
  }
}

main().catch((error) => {
  console.error(bad(`\nPROOF FAILED: ${error.message}`));
  if (VERBOSE) console.error(error);
  process.exit(1);
});
