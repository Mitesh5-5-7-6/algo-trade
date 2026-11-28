/**
 * Meta-lab (PLAN.md 14.22, 2026-11-28): a trained review of the live Momentum
 * rule's signals — meta-labeling (López de Prado). The rule proposes; a model
 * trained on the conditions at each past signal decides which to take. Reads
 * only.
 *
 *   node --env-file=../../.env.local scripts/meta-lab.mts
 *
 * - Signals: the live rule on stored 5m index bars (N-bar breakout beyond the
 *   EMA, 09:35–14:15, one per direction a day), exits as live (premium stop
 *   and target as index distances at delta 0.5), costs of the NEW vehicle
 *   (1-step ITM, 5+ days to expiry: 0.02% a round trip, 0.005%/hour decay).
 * - Features: 18 conditions known at the signal bar's close — nothing later.
 * - Model: L2 logistic regression, standardised on the training period only.
 * - Honesty: trained on the first 60% of sessions, judged on the last 40%;
 *   then the reverse (trained on the later, judged on the earlier) — a review
 *   that only works one way round is luck.
 */
import dns from "node:dns";
import { MongoClient } from "mongodb";

dns.setServers(["1.1.1.1"]);
const IST = 19_800_000;
const COST = 0.0002;
const DECAY_PER_HOUR = 0.00005;

interface Bar { ts: number; open: number; high: number; low: number; close: number }
interface Day { date: string; bars: Bar[]; prev: { high: number; low: number; close: number } | null; prevPrevClose: number | null; nr7: boolean; expiry: boolean }
interface Sample { x: number[]; net: number; win: boolean; period: number; date: string }

const minuteOf = (ts: number) => Math.floor(((ts + IST) % 86_400_000) / 60_000);
const hm = (h: number, m: number) => h * 60 + m;
const FEATURES = [
  "minutes since open", "gap (with the trade)", "move from open (with)", "range so far",
  "position in range (with)", "beyond PDH/PDL (with)", "RSI14 (with)", "ADX14",
  "distance from EMA20 (with)", "first half hour agrees", "previous day (with)", "yesterday NR7",
  "expiry day", "realised volatility (12 bars)", "breakout extension", "crosses of the open",
  "BANKNIFTY", "distance from average price (with)",
];

function walk(bars: Bar[], i: number, dir: 1 | -1, stopPct: number, targetPct: number): { exit: number; held: number; entry: number } | null {
  const first = bars[i + 1];
  if (first === undefined) return null;
  const entry = first.open, stop = entry * (1 - dir * stopPct), target = entry * (1 + dir * targetPct);
  for (let j = i + 1; j < bars.length; j += 1) {
    const b = bars[j]!;
    const held = minuteOf(b.ts) + 5 - minuteOf(first.ts);
    if (dir === 1 ? b.low <= stop : b.high >= stop) return { exit: stop, held, entry };
    if (dir === 1 ? b.high >= target : b.low <= target) return { exit: target, held, entry };
    if (minuteOf(b.ts) >= hm(15, 5)) return { exit: b.close, held, entry };
  }
  return null;
}

function isExpiry(date: string, nifty: boolean): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  if (d.getUTCDay() !== 2) return false;
  return nifty || new Date(d.getTime() + 7 * 86_400_000).getUTCMonth() !== d.getUTCMonth();
}

async function samplesFor(db: ReturnType<MongoClient["db"]>, sym: string): Promise<Sample[]> {
  const nifty = sym.includes("NIFTY50");
  const raw = (await db.collection("candles").find({ symbol: sym, interval: "5m" }, { projection: { _id: 0, ts: 1, open: 1, high: 1, low: 1, close: 1 } }).sort({ ts: 1 }).toArray()) as unknown as Bar[];
  const byDay = new Map<string, Bar[]>();
  for (const b of raw) {
    const m = minuteOf(b.ts);
    if (m < hm(9, 15) || m > hm(15, 25)) continue;
    const date = new Date(b.ts + IST).toISOString().slice(0, 10);
    (byDay.get(date) ?? byDay.set(date, []).get(date)!).push(b);
  }
  const days: Day[] = [];
  const hist: { high: number; low: number; close: number }[] = [];
  for (const [date, bars] of [...byDay.entries()].sort()) {
    if (bars.length < 60) continue;
    const prev = hist.at(-1) ?? null;
    const ranges = hist.slice(-7).map((h) => h.high - h.low);
    days.push({ date, bars, prev, prevPrevClose: hist.at(-2)?.close ?? null, nr7: ranges.length === 7 && ranges[6]! <= Math.min(...ranges), expiry: isExpiry(date, nifty) });
    hist.push({ high: Math.max(...bars.map((b) => b.high)), low: Math.min(...bars.map((b) => b.low)), close: bars.at(-1)!.close });
  }
  // Indicators over the whole series (EMA/RSI/ADX carry across days, as live).
  const flat = days.flatMap((d) => d.bars);
  const ema: number[] = [], rsi: number[] = [], adx: number[] = [];
  const kE = 2 / ((nifty ? 21 : 13) + 1);
  let up = 0, dn = 0, trS = 0, pS = 0, nS = 0, ax = 0;
  flat.forEach((b, i) => {
    const p = flat[i - 1];
    ema.push(i === 0 ? b.close : b.close * kE + ema[i - 1]! * (1 - kE));
    if (!p) { rsi.push(50); adx.push(0); return; }
    const ch = b.close - p.close;
    up = (up * 13 + Math.max(ch, 0)) / 14; dn = (dn * 13 + Math.max(-ch, 0)) / 14;
    rsi.push(dn === 0 ? 100 : 100 - 100 / (1 + up / dn));
    const tr = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    const um = b.high - p.high, dm = p.low - b.low;
    trS = trS - trS / 14 + tr; pS = pS - pS / 14 + (um > dm && um > 0 ? um : 0); nS = nS - nS / 14 + (dm > um && dm > 0 ? dm : 0);
    const pdi = trS ? (100 * pS) / trS : 0, ndi = trS ? (100 * nS) / trS : 0;
    ax = (ax * 13 + (pdi + ndi ? (100 * Math.abs(pdi - ndi)) / (pdi + ndi) : 0)) / 14; adx.push(ax);
  });

  const N = nifty ? 10 : 8;
  const stopPct = nifty ? 0.0039 : 0.0106, targetPct = nifty ? 0.0094 : 0.0312;
  const out: Sample[] = [];
  let off = 0;
  days.forEach((day, k) => {
    const open = day.bars[0]!.open;
    const at945 = day.bars.find((b) => minuteOf(b.ts) + 5 === hm(9, 45));
    let long = false, short = false, sum = 0;
    day.bars.forEach((b, i) => {
      sum += (b.high + b.low + b.close) / 3;
      const m = minuteOf(b.ts) + 5;
      if (m < hm(9, 35) || m > hm(14, 15) || i < N || day.prev === null) return;
      const w = day.bars.slice(i - N, i);
      const hi = Math.max(...w.map((x) => x.high)), lo = Math.min(...w.map((x) => x.low));
      const e = ema[off + i]!;
      for (const dir of [1, -1] as const) {
        if (dir === 1 ? long || !(b.close > hi && b.close > e) : short || !(b.close < lo && b.close < e)) continue;
        if (dir === 1) long = true; else short = true;
        const r = walk(day.bars, i, dir, stopPct, targetPct);
        if (!r) continue;
        const sofar = day.bars.slice(0, i + 1);
        const dHi = Math.max(...sofar.map((x) => x.high)), dLo = Math.min(...sofar.map((x) => x.low));
        const rets = day.bars.slice(Math.max(1, i - 11), i + 1).map((x, j, a) => (j === 0 ? 0 : Math.log(x.close / a[j - 1]!.close))).slice(1);
        const vol = Math.sqrt(rets.reduce((a, v) => a + v * v, 0) / Math.max(1, rets.length));
        const crosses = sofar.slice(1).filter((x, j) => Math.sign(x.close - open) !== Math.sign(sofar[j]!.close - open)).length;
        const x = [
          m - hm(9, 15),
          (dir * (open - day.prev.close)) / day.prev.close,
          (dir * (b.close - open)) / open,
          (dHi - dLo) / open,
          dHi > dLo ? (dir === 1 ? (b.close - dLo) / (dHi - dLo) : (dHi - b.close) / (dHi - dLo)) : 0.5,
          dir === 1 ? (b.close - day.prev.high) / b.close : (day.prev.low - b.close) / b.close,
          dir === 1 ? rsi[off + i]! : 100 - rsi[off + i]!,
          adx[off + i]!,
          (dir * (b.close - e)) / b.close,
          at945 && m > hm(9, 45) ? dir * Math.sign(at945.close - day.prev.close) : 0,
          day.prevPrevClose ? (dir * (day.prev.close - day.prevPrevClose)) / day.prevPrevClose : 0,
          day.nr7 ? 1 : 0,
          day.expiry ? 1 : 0,
          vol,
          (dir * (b.close - (dir === 1 ? hi : lo))) / b.close,
          crosses,
          nifty ? 0 : 1,
          (dir * (b.close - sum / (i + 1))) / b.close,
        ];
        const net = (dir * (r.exit - r.entry)) / r.entry - COST - (DECAY_PER_HOUR * r.held) / 60;
        out.push({ x, net, win: net > 0, period: k / days.length, date: day.date });
      }
    });
    off += day.bars.length;
  });
  return out;
}

/** L2 logistic regression by gradient descent on standardised features. */
function train(rows: Sample[], lambda = 0.05, epochs = 3000, lr = 0.1) {
  const d = rows[0]!.x.length;
  const mean = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const r of rows) r.x.forEach((v, j) => (mean[j] += v / rows.length));
  for (const r of rows) r.x.forEach((v, j) => (sd[j] += (v - mean[j]) ** 2 / rows.length));
  for (let j = 0; j < d; j += 1) sd[j] = Math.sqrt(sd[j]) || 1;
  const z = (x: number[]) => x.map((v, j) => (v - mean[j]) / sd[j]);
  const X = rows.map((r) => z(r.x)), y = rows.map((r) => (r.win ? 1 : 0));
  const w = new Array(d).fill(0);
  let b = 0;
  for (let e = 0; e < epochs; e += 1) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    X.forEach((xi, i) => {
      const p = 1 / (1 + Math.exp(-(b + xi.reduce((a, v, j) => a + v * w[j], 0))));
      const err = p - y[i]!;
      xi.forEach((v, j) => (gw[j] += (err * v) / X.length));
      gb += err / X.length;
    });
    for (let j = 0; j < d; j += 1) w[j] -= lr * (gw[j] + lambda * w[j]);
    b -= lr * gb;
  }
  return { w, predict: (x: number[]) => 1 / (1 + Math.exp(-(b + z(x).reduce((a, v, j) => a + v * w[j], 0)))) };
}

const stats = (rs: Sample[]) => {
  const w = rs.filter((r) => r.net > 0), l = rs.filter((r) => r.net <= 0);
  const g = w.reduce((a, r) => a + r.net, 0), lo = -l.reduce((a, r) => a + r.net, 0);
  return `${String(rs.length).padStart(4)} trades  win ${(rs.length ? (w.length / rs.length) * 100 : 0).toFixed(0).padStart(3)}%  avg ${((rs.reduce((a, r) => a + r.net, 0) / (rs.length || 1)) * 100).toFixed(3).padStart(7)}%  PF ${(lo > 0 ? g / lo : 0).toFixed(2)}`;
};

function evaluate(trainRows: Sample[], testRows: Sample[], label: string) {
  const model = train(trainRows);
  const trainScores = trainRows.map((r) => model.predict(r.x)).sort((a, b) => b - a);
  console.log(`\n${label}: train ${String(trainRows.length)} signals, test ${String(testRows.length)}`);
  console.log(`  ${"all signals (no review)".padEnd(38)} train ${stats(trainRows)} | test ${stats(testRows)}`);
  for (const share of [0.5, 0.3, 0.2]) {
    // The threshold is fixed on the TRAINING scores, then applied unchanged.
    const threshold = trainScores[Math.floor(trainScores.length * share)]!;
    const tr = trainRows.filter((r) => model.predict(r.x) >= threshold);
    const te = testRows.filter((r) => model.predict(r.x) >= threshold);
    console.log(`  ${`review takes the top ${String(share * 100)}%`.padEnd(38)} train ${stats(tr)} | test ${stats(te)}`);
  }
  return model;
}

const client = new MongoClient(process.env.MONGO_URI ?? "");
await client.connect();
try {
  const db = client.db("neelkanth_research");
  const all = [...(await samplesFor(db, "NSE:NIFTY50-INDEX")), ...(await samplesFor(db, "NSE:NIFTYBANK-INDEX"))];
  const early = all.filter((r) => r.period < 0.6), late = all.filter((r) => r.period >= 0.6);
  console.log(`${String(all.length)} past signals of the live Momentum rule; costs of the new vehicle (1-step ITM, 5+ days)`);
  const model = evaluate(early, late, "FORWARD — trained on the first 60%, judged on the last 40%");
  evaluate(late, early, "REVERSE — trained on the last 40%, judged on the first 60%");
  console.log("\nwhat the forward model leans on (standardised weights; + = more likely to win)");
  model.w
    .map((v, j) => [FEATURES[j]!, v] as const)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .forEach(([n, v]) => console.log(`  ${n.padEnd(38)} ${v >= 0 ? "+" : ""}${v.toFixed(3)}`));
} finally {
  await client.close();
}
