/**
 * THROWAWAY PROBE — FYERS History API (Phase 1, design §10.1).
 *
 * Answers the five questions the vendor client cannot
 * (docs/design/PHASE_1_HISTORICAL_DATA.md §10.1):
 *
 *   Q1  maximum range per request, per resolution
 *   Q2  how far back 5-minute history is retained
 *   Q3  data-API rate limits                        (opt-in, see --rate-limits)
 *   Q4  whether index volume is real or always zero
 *   Q5  behaviour on a holiday or non-trading range
 *
 * It exists to replace assumptions with measurements. Record the answers in
 * the design's §3, then DELETE THIS FILE — the measuring apparatus is not
 * meant to ship, and none of it should be copied into the ingestion path.
 *
 * Safety:
 *   - Read-only. Market data only. It never places an order and never writes
 *     to Mongo; it reads the stored broker token and global settings.
 *   - Conservative by default: ~25 calls, spaced. The rate-limit burst (Q3) is
 *     opt-in, because hammering a real broker account is how an account gets
 *     throttled or flagged.
 *
 * Run from apps/api:
 *   node --env-file=../../.env.local scripts/probe-fyers-history.mts
 *   node --env-file=../../.env.local scripts/probe-fyers-history.mts --rate-limits
 *
 * Optional: --symbol=NSE:NIFTY50-INDEX  --equity=NSE:SBIN-EQ
 */

import { MongoClient } from "mongodb";
import { tradingDaysBetween } from "@neelkanth/engines";

const HISTORY_URL = "https://api-t1.fyers.in/data/history";
const RESOLUTION = "5";
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? "true"] as const;
    }),
);

const INDEX_SYMBOL = args.get("symbol") ?? "NSE:NIFTY50-INDEX";
const EQUITY_SYMBOL = args.get("equity") ?? "NSE:SBIN-EQ";
const PROBE_RATE_LIMITS = args.get("rate-limits") === "true";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dateKey = (ms: number) =>
  new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

interface HistoryResponse {
  status: number;
  /** Raw body, parsed when it was JSON. */
  body: { s?: string; message?: string; candles?: number[][] } | string;
  /** Response headers that look rate-limit related. */
  rateHeaders: Record<string, string>;
  elapsedMs: number;
}

async function fetchHistory(
  auth: { appId: string; token: string },
  symbol: string,
  fromKey: string,
  toKey: string,
): Promise<HistoryResponse> {
  const url = `${HISTORY_URL}?${new URLSearchParams({
    symbol,
    resolution: RESOLUTION,
    date_format: "1",
    range_from: fromKey,
    range_to: toKey,
    cont_flag: "1",
  }).toString()}`;

  const started = Date.now();
  const response = await fetch(url, {
    headers: {
      Authorization: `${auth.appId}:${auth.token}`,
      version: "3",
    },
  });
  const elapsedMs = Date.now() - started;

  const rateHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (/rate|limit|retry|quota|remaining/i.test(key)) rateHeaders[key] = value;
  });

  const text = await response.text();
  let body: HistoryResponse["body"];
  try {
    body = JSON.parse(text) as HistoryResponse["body"];
  } catch {
    body = text.slice(0, 400);
  }
  return { status: response.status, body, rateHeaders, elapsedMs };
}

function candlesOf(r: HistoryResponse): number[][] {
  return typeof r.body === "object" && Array.isArray(r.body.candles)
    ? r.body.candles
    : [];
}

function describe(r: HistoryResponse): string {
  const s = typeof r.body === "object" ? (r.body.s ?? "?") : "non-json";
  const msg = typeof r.body === "object" ? (r.body.message ?? "") : "";
  const n = candlesOf(r).length;
  return `HTTP ${String(r.status)} s=${s} candles=${String(n)}${msg ? ` msg="${msg}"` : ""} (${String(r.elapsedMs)}ms)`;
}

/** Span actually covered by the returned bars, in IST date keys. */
function returnedSpan(r: HistoryResponse): {
  first: string;
  last: string;
  days: number;
} | null {
  const c = candlesOf(r);
  if (c.length === 0) return null;
  const firstTs = (c[0]?.[0] ?? 0) * 1000;
  const lastTs = (c[c.length - 1]?.[0] ?? 0) * 1000;
  return {
    first: dateKey(firstTs),
    last: dateKey(lastTs),
    days: Math.round((lastTs - firstTs) / DAY_MS) + 1,
  };
}

async function loadAuth(): Promise<{
  appId: string;
  token: string;
  holidays: string[];
}> {
  const appId = process.env.FYERS_APP_ID;
  if (!appId) throw new Error("FYERS_APP_ID is not set");

  const envToken = process.env.FYERS_ACCESS_TOKEN;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  const keyHex = process.env.TOKEN_ENCRYPTION_KEY;

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try {
    const db = client.db();
    const settings = await db.collection("settings").findOne({
      scope: "global",
    });
    const holidays = (settings?.marketHolidays as string[] | undefined) ?? [];

    if (envToken) return { appId, token: envToken, holidays };

    if (!keyHex) {
      throw new Error(
        "TOKEN_ENCRYPTION_KEY is not set and FYERS_ACCESS_TOKEN was not provided",
      );
    }
    const user = await db.collection("users").findOne({});
    if (!user) throw new Error("no operator account in the users collection");
    const row = await db
      .collection("broker_tokens")
      .findOne({ userId: user.userId as string });
    if (!row) {
      throw new Error(
        "no FYERS token stored — connect the broker from Settings first",
      );
    }

    // Same AES-256-GCM layout BrokerTokensRepository writes: iv | authTag | ct.
    const { createDecipheriv } = await import("node:crypto");
    const data = Buffer.from(row.accessToken as string, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(keyHex, "hex"),
      data.subarray(0, 12),
    );
    decipher.setAuthTag(data.subarray(12, 28));
    const token =
      decipher.update(data.subarray(28)).toString("utf8") +
      decipher.final("utf8");
    return { appId, token, holidays };
  } finally {
    await client.close();
  }
}

/** A recent, definitely-open trading day (walks back from yesterday). */
function recentTradingDay(holidays: ReadonlySet<string>): string {
  const now = Date.now();
  const days = tradingDaysBetween(now - 21 * DAY_MS, now - DAY_MS, holidays);
  const last = days.at(-1);
  if (!last) throw new Error("no trading day found in the last three weeks");
  return last;
}

/** The most recent Saturday — guaranteed non-trading, no calendar guesswork. */
function recentSaturday(): string {
  let ms = Date.now() - DAY_MS;
  while (new Date(ms + IST_OFFSET_MS).getUTCDay() !== 6) ms -= DAY_MS;
  return dateKey(ms);
}

async function main(): Promise<void> {
  const { appId, token, holidays } = await loadAuth();
  const holidaySet = new Set(holidays);
  const auth = { appId, token };
  const findings: Record<string, unknown> = {};

  const tradingDay = recentTradingDay(holidaySet);
  console.log(`\n=== FYERS History probe ===`);
  console.log(`index symbol  : ${INDEX_SYMBOL}`);
  console.log(`equity symbol : ${EQUITY_SYMBOL}`);
  console.log(`trading day   : ${tradingDay}`);
  console.log(`resolution    : ${RESOLUTION} (5-minute)\n`);

  // ---- Q5: what a non-trading range actually returns -----------------------
  console.log("--- Q5  non-trading range ---");
  const saturday = recentSaturday();
  const satResponse = await fetchHistory(
    auth,
    INDEX_SYMBOL,
    saturday,
    saturday,
  );
  console.log(`  saturday ${saturday}: ${describe(satResponse)}`);
  findings.q5_saturday = {
    date: saturday,
    status: satResponse.status,
    body: satResponse.body,
  };

  const holiday = [...holidaySet].sort().at(-1);
  if (holiday) {
    await sleep(400);
    const holResponse = await fetchHistory(
      auth,
      INDEX_SYMBOL,
      holiday,
      holiday,
    );
    console.log(`  holiday  ${holiday}: ${describe(holResponse)}`);
    findings.q5_holiday = {
      date: holiday,
      status: holResponse.status,
      body: holResponse.body,
    };
  } else {
    console.log("  (no marketHolidays configured — Saturday result only)");
  }

  // ---- Q4: is index volume real? ------------------------------------------
  console.log("\n--- Q4  index volume ---");
  for (const [label, symbol] of [
    ["index ", INDEX_SYMBOL],
    ["equity", EQUITY_SYMBOL],
  ] as const) {
    await sleep(400);
    const response = await fetchHistory(auth, symbol, tradingDay, tradingDay);
    const volumes = candlesOf(response).map((c) => c[5] ?? 0);
    const nonZero = volumes.filter((v) => v > 0).length;
    console.log(
      `  ${label} ${symbol}: bars=${String(volumes.length)} ` +
        `non-zero volume=${String(nonZero)} ` +
        `total=${String(volumes.reduce((a, b) => a + b, 0))}`,
    );
    findings[`q4_${label.trim()}`] = {
      symbol,
      bars: volumes.length,
      nonZeroVolumeBars: nonZero,
    };
  }

  // ---- Q1: maximum range per request --------------------------------------
  // The API may TRUNCATE silently rather than error, so compare the span we
  // asked for against the span actually returned. A shorter answer with s=ok
  // is the cap, not a success.
  console.log("\n--- Q1  maximum range per request ---");
  const q1: unknown[] = [];
  for (const span of [30, 60, 100, 150, 200, 400]) {
    await sleep(500);
    const to = Date.now() - DAY_MS;
    const from = to - span * DAY_MS;
    const response = await fetchHistory(
      auth,
      INDEX_SYMBOL,
      dateKey(from),
      dateKey(to),
    );
    const got = returnedSpan(response);
    const verdict =
      got === null
        ? "no data"
        : got.days >= span - 5
          ? "FULL"
          : `TRUNCATED to ~${String(got.days)}d`;
    console.log(
      `  requested ${String(span).padStart(3)}d: ${describe(response)}` +
        `${got ? ` → ${got.first}..${got.last}` : ""}  ${verdict}`,
    );
    q1.push({ requestedDays: span, returned: got, status: response.status });
    if (response.status !== 200) break;
  }
  findings.q1_maxRange = q1;

  // ---- Q2: retention depth -------------------------------------------------
  console.log("\n--- Q2  how far back 5m history goes ---");
  const q2: unknown[] = [];
  for (const yearsBack of [1, 2, 3, 5, 8]) {
    await sleep(500);
    const centre = Date.now() - yearsBack * 365 * DAY_MS;
    const days = tradingDaysBetween(centre, centre + 10 * DAY_MS, holidaySet);
    const probeDay = days[0];
    if (!probeDay) continue;
    const response = await fetchHistory(auth, INDEX_SYMBOL, probeDay, probeDay);
    const n = candlesOf(response).length;
    console.log(
      `  ${String(yearsBack)}y ago (${probeDay}): ${describe(response)} → ${n > 0 ? "AVAILABLE" : "empty"}`,
    );
    q2.push({ yearsBack, date: probeDay, bars: n, status: response.status });
    if (n === 0) break;
  }
  findings.q2_retention = q2;

  // ---- Q3: rate limits (opt-in) -------------------------------------------
  console.log("\n--- Q3  rate limits ---");
  if (!PROBE_RATE_LIMITS) {
    console.log(
      "  SKIPPED. Re-run with --rate-limits to measure.\n" +
        "  It issues 20 back-to-back calls, which is deliberately not the default:\n" +
        "  hammering a live broker account is how one gets throttled or flagged.",
    );
    const seen = satResponse.rateHeaders;
    console.log(
      Object.keys(seen).length > 0
        ? `  rate-limit headers seen on a normal call: ${JSON.stringify(seen)}`
        : "  no rate-limit headers on a normal response",
    );
    findings.q3_rateLimits = { probed: false, headers: seen };
  } else {
    const results: { status: number; ms: number }[] = [];
    for (let i = 0; i < 20; i += 1) {
      const response = await fetchHistory(
        auth,
        INDEX_SYMBOL,
        tradingDay,
        tradingDay,
      );
      results.push({ status: response.status, ms: response.elapsedMs });
      if (response.status === 429 || response.status >= 500) {
        console.log(
          `  call ${String(i + 1)}: ${describe(response)}  ← refused, stopping`,
        );
        findings.q3_refusedAt = i + 1;
        findings.q3_refusalBody = response.body;
        findings.q3_refusalHeaders = response.rateHeaders;
        break;
      }
    }
    const ok = results.filter((r) => r.status === 200).length;
    const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
    console.log(
      `  ${String(ok)}/${String(results.length)} succeeded back-to-back; ` +
        `latency min=${String(latencies[0] ?? 0)}ms ` +
        `median=${String(latencies[Math.floor(latencies.length / 2)] ?? 0)}ms ` +
        `max=${String(latencies.at(-1) ?? 0)}ms`,
    );
    findings.q3_rateLimits = { probed: true, calls: results };
  }

  console.log("\n=== paste into design §3 ===");
  console.log(JSON.stringify(findings, null, 2));
  console.log(
    "\nRecord the answers in docs/design/PHASE_1_HISTORICAL_DATA.md §3,\n" +
      "mark §3.1 resolved, then delete this script.\n",
  );
}

main().catch((error: unknown) => {
  console.error(
    "\nprobe failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
