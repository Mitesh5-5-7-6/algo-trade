/**
 * Strategy lab (PLAN.md 14.22): win rate AND net result of candidate intraday
 * strategy families on the stored 5m NIFTY / BANKNIFTY bars. Reads only.
 *
 *   node --env-file=../../.env.local scripts/strategy-lab.mts
 *
 * Honest by construction:
 *  - rules fixed before running; the first 60% of sessions are "in-sample",
 *    the last 40% "out-of-sample" — a family counts only if it holds there;
 *  - entry at the NEXT bar's open, a bar touching stop and target counts as
 *    the stop, exits by the 15:10 bar at the latest;
 *  - an option bought at the money is approximated on the index at delta 0.5:
 *    net = move − costs (0.02% of the index a round trip: brokerage, taxes,
 *    slippage) − time decay (0.02% of the index per hour held).
 * Results are in % of the index; × index × 0.5 × lot size gives ₹ per lot.
 */
import dns from "node:dns";
import { MongoClient } from "mongodb";

dns.setServers(["1.1.1.1"]);
const IST = 19_800_000;
const COST = 0.0002;
const DECAY_PER_HOUR = 0.0002;

interface Bar { ts: number; open: number; high: number; low: number; close: number }
interface Day { date: string; bars: Bar[]; prevClose: number | null }
interface Trade {
  dir: 1 | -1; entry: number; exit: number; heldMin: number; oos: boolean;
  /** Conditions at the signal, for the review study (family A only). */
  f?: Record<string, string>;
}

const minuteOf = (ts: number) => Math.floor(((ts + IST) % 86_400_000) / 60_000);
const hm = (h: number, m: number) => h * 60 + m;

/** Walk forward from bar i+1 (entry at its open) until stop, target or time. */
function run(
  bars: Bar[], i: number, dir: 1 | -1, stopPct: number, targetPct: number,
  maxHoldMin: number, oos: boolean,
): Trade | null {
  const first = bars[i + 1];
  if (first === undefined) return null;
  const entry = first.open;
  const stop = entry * (1 - dir * stopPct);
  const target = entry * (1 + dir * targetPct);
  for (let j = i + 1; j < bars.length; j += 1) {
    const b = bars[j]!;
    const held = minuteOf(b.ts) + 5 - minuteOf(first.ts);
    const stopped = dir === 1 ? b.low <= stop : b.high >= stop;
    if (stopped) return { dir, entry, exit: stop, heldMin: held, oos };
    const hit = dir === 1 ? b.high >= target : b.low <= target;
    if (hit) return { dir, entry, exit: target, heldMin: held, oos };
    if (held >= maxHoldMin || minuteOf(b.ts) >= hm(15, 5))
      return { dir, entry, exit: b.close, heldMin: held, oos };
  }
  const last = bars.at(-1)!;
  return { dir, entry, exit: last.close, heldMin: minuteOf(last.ts) + 5 - minuteOf(first.ts), oos };
}

const net = (t: Trade) =>
  (t.dir * (t.exit - t.entry)) / t.entry - COST - (DECAY_PER_HOUR * t.heldMin) / 60;

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1]! * (1 - k)));
  return out;
}
function rsi(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(50);
  let up = 0, down = 0;
  for (let i = 1; i < values.length; i += 1) {
    const ch = values[i]! - values[i - 1]!;
    up = (up * (period - 1) + Math.max(ch, 0)) / period;
    down = (down * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = down === 0 ? 100 : 100 - 100 / (1 + up / down);
  }
  return out;
}

type Family = (day: Day, sym: string, oos: boolean, all: { closes: number[]; offset: number }) => Trade[];

/** Yesterday was NR7 (narrowest range of 7 days) / an inside day — Crabel's expansion setups. */
const quietYesterday = new Map<string, { nr7: boolean; inside: boolean }>();

/** The live Momentum rule on the index: an N-bar breakout beyond the EMA (no VWAP: no futures stored). */
const momentum = (exitAtT1: boolean): Family => (day, sym, oos, all) => {
  const nifty = sym.includes("NIFTY50");
  const N = nifty ? 10 : 8;
  // Premium stop/target as index distances at delta 0.5 (weekly NIFTY ATM ≈ 0.78% of
  // the index; monthly BANKNIFTY ≈ 2.4%): NIFTY −25% / +60%, BANKNIFTY −22% / +65%.
  const stop = nifty ? 0.0039 : 0.0106;
  const fullTarget = nifty ? 0.0094 : 0.0312;
  const target = exitAtT1 ? fullTarget / 3 : fullTarget;
  const e = ema(all.closes, nifty ? 21 : 13);
  const out: Trade[] = [];
  let long = false, short = false;
  const open = day.bars[0]!.open;
  const at945 = day.bars.find((x) => minuteOf(x.ts) + 5 === hm(9, 45));
  const features = (i: number, dir: 1 | -1): Record<string, string> => {
    const b = day.bars[i]!;
    const m = minuteOf(b.ts) + 5;
    const sofar = day.bars.slice(0, i + 1);
    const range = (Math.max(...sofar.map((x) => x.high)) - Math.min(...sofar.map((x) => x.low))) / open;
    const run = (dir * (b.close - open)) / open;
    const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
    return {
      "with the first half hour": day.prevClose !== null && at945 !== undefined && sgn(at945.close - day.prevClose) === dir ? "yes" : "no",
      "with the gap": day.prevClose !== null && sgn(open - day.prevClose) === dir ? "yes" : "no",
      "time": m < hm(11, 0) ? "before 11:00" : m < hm(13, 0) ? "11:00-13:00" : "after 13:00",
      "already run from the open": run < 0.003 ? "<0.3%" : run < 0.007 ? "0.3-0.7%" : ">0.7%",
      "day's range so far": range < 0.005 ? "<0.5%" : range < 0.01 ? "0.5-1%" : ">1%",
      "yesterday NR7": quietYesterday.get(`${sym}|${day.date}`)?.nr7 ? "yes" : "no",
      "yesterday inside day": quietYesterday.get(`${sym}|${day.date}`)?.inside ? "yes" : "no",
    };
  };
  day.bars.forEach((b, i) => {
    const m = minuteOf(b.ts) + 5;
    if (m < hm(9, 35) || m > hm(14, 15) || i < N) return;
    const window = day.bars.slice(i - N, i);
    const hi = Math.max(...window.map((x) => x.high)), lo = Math.min(...window.map((x) => x.low));
    const ev = e[all.offset + i]!;
    if (!long && b.close > hi && b.close > ev) { long = true; const t = run(day.bars, i, 1, stop, target, 400, oos); if (t) out.push({ ...t, f: features(i, 1) }); }
    if (!short && b.close < lo && b.close < ev) { short = true; const t = run(day.bars, i, -1, stop, target, 400, oos); if (t) out.push({ ...t, f: features(i, -1) }); }
  });
  return out;
};

/** Mean reversion: 5m RSI(2) stretched; small target, wider stop, short hold. */
const meanReversion = (withTrend: boolean, targetPct: number, stopPct: number): Family => (day, _sym, oos, all) => {
  const r = rsi(all.closes, 2);
  const out: Trade[] = [];
  let lastExitIdx = -1;
  const open = day.bars[0]?.open ?? 0;
  day.bars.forEach((b, i) => {
    const m = minuteOf(b.ts) + 5;
    if (m < hm(10, 0) || m > hm(14, 30) || i <= lastExitIdx) return;
    const v = r[all.offset + i]!;
    let dir: 1 | -1 | 0 = v < 5 ? 1 : v > 95 ? -1 : 0;
    if (dir !== 0 && withTrend && (dir === 1 ? b.close < open : b.close > open)) dir = 0;
    if (dir === 0) return;
    const t = run(day.bars, i, dir, stopPct, targetPct, 45, oos);
    if (t) { out.push(t); lastExitIdx = i + Math.ceil(t.heldMin / 5); }
  });
  return out;
};

/** Intraday momentum (Gao et al. 2018): the open-to-09:45 return's sign, held 14:40 → 15:10. */
const intradayMomentum: Family = (day, _sym, oos) => {
  if (day.prevClose === null) return [];
  const at945 = day.bars.find((b) => minuteOf(b.ts) + 5 === hm(9, 45));
  const iEntry = day.bars.findIndex((b) => minuteOf(b.ts) + 5 === hm(14, 40));
  if (at945 === undefined || iEntry < 0) return [];
  const dir: 1 | -1 = at945.close >= day.prevClose ? 1 : -1;
  const t = run(day.bars, iEntry, dir, 0.01, 0.01, 30, oos);
  return t ? [t] : [];
};

/** Gap fade: a gap of 0.3%+ traded back toward yesterday's close; half the gap as target. */
const gapFade: Family = (day, _sym, oos) => {
  const first = day.bars[0];
  if (day.prevClose === null || first === undefined) return [];
  const gap = first.open / day.prevClose - 1;
  if (Math.abs(gap) < 0.003) return [];
  const dir: 1 | -1 = gap > 0 ? -1 : 1;
  const t = run(day.bars, 0, dir, Math.abs(gap) * 0.5, Math.abs(gap) * 0.5, 100, oos);
  return t ? [t] : [];
};

const FAMILIES: [string, Family][] = [
  ["A. Momentum breakout, full target (live rule)", momentum(false)],
  ["B. Momentum breakout, exit at T1", momentum(true)],
  ["C1. Mean reversion RSI(2), +0.15% / −0.30%", meanReversion(false, 0.0015, 0.003)],
  ["C2. Mean reversion RSI(2) with the day, +0.15% / −0.30%", meanReversion(true, 0.0015, 0.003)],
  ["C3. Mean reversion RSI(2) with the day, +0.10% / −0.40%", meanReversion(true, 0.001, 0.004)],
  ["D. Intraday momentum (first half hour → last half hour)", intradayMomentum],
  ["E. Gap fade (gaps of 0.3%+)", gapFade],
];

const client = new MongoClient(process.env.MONGO_URI ?? "");
await client.connect();
try {
  const db = client.db("neelkanth_research");
  const results = new Map<string, Trade[]>();
  for (const sym of ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX"]) {
    const raw = (await db.collection("candles").find({ symbol: sym, interval: "5m" }, { projection: { _id: 0, ts: 1, open: 1, high: 1, low: 1, close: 1 } }).sort({ ts: 1 }).toArray()) as unknown as Bar[];
    const byDay = new Map<string, Bar[]>();
    for (const b of raw) {
      const m = minuteOf(b.ts);
      if (m < hm(9, 15) || m > hm(15, 25)) continue;
      const date = new Date(b.ts + IST).toISOString().slice(0, 10);
      (byDay.get(date) ?? byDay.set(date, []).get(date)!).push(b);
    }
    const days: Day[] = [];
    let prev: number | null = null;
    for (const [date, bars] of [...byDay.entries()].sort()) {
      if (bars.length < 60) { prev = bars.at(-1)?.close ?? prev; continue; }
      days.push({ date, bars, prevClose: prev });
      prev = bars.at(-1)!.close;
    }
    const closes = days.flatMap((d) => d.bars.map((b) => b.close));
    days.forEach((day, k) => {
      if (k < 7) return;
      const hl = (d: Day) => ({ h: Math.max(...d.bars.map((b) => b.high)), l: Math.min(...d.bars.map((b) => b.low)) });
      const y = hl(days[k - 1]!), yy = hl(days[k - 2]!);
      const ranges = days.slice(k - 7, k).map((d) => { const r = hl(d); return r.h - r.l; });
      quietYesterday.set(`${sym}|${day.date}`, {
        nr7: ranges[6]! <= Math.min(...ranges),
        inside: y.h <= yy.h && y.l >= yy.l,
      });
    });
    const split = Math.floor(days.length * 0.6);
    console.log(`${sym}: ${String(days.length)} sessions ${days[0]?.date} → ${days.at(-1)?.date}; out-of-sample from ${days[split]?.date}`);
    for (const [name, family] of FAMILIES) {
      let offset = 0;
      const list = results.get(name) ?? [];
      days.forEach((day, k) => {
        list.push(...family(day, sym, k >= split, { closes, offset }));
        offset += day.bars.length;
      });
      results.set(name, list);
    }
  }
  const stats = (ts: Trade[]) => {
    const n = ts.map(net);
    const wins = n.filter((x) => x > 0);
    const losses = n.filter((x) => x <= 0);
    const gain = wins.reduce((a, b) => a + b, 0), loss = -losses.reduce((a, b) => a + b, 0);
    return {
      trades: ts.length,
      win: ts.length ? (wins.length / ts.length) * 100 : 0,
      avg: ts.length ? (n.reduce((a, b) => a + b, 0) / ts.length) * 100 : 0,
      avgWin: wins.length ? (gain / wins.length) * 100 : 0,
      avgLoss: losses.length ? (loss / losses.length) * 100 : 0,
      pf: loss > 0 ? gain / loss : Infinity,
    };
  };
  const fmt = (s: ReturnType<typeof stats>) =>
    `${String(s.trades).padStart(4)} trades  win ${s.win.toFixed(0).padStart(3)}%  avg ${s.avg >= 0 ? "+" : ""}${s.avg.toFixed(3)}%  (win +${s.avgWin.toFixed(3)} / loss −${s.avgLoss.toFixed(3)})  PF ${s.pf.toFixed(2)}`;
  console.log("\nfamily                                                   | in-sample                                                        | OUT-OF-SAMPLE");
  for (const [name, ts] of results) {
    console.log(name.padEnd(56), "|", fmt(stats(ts.filter((t) => !t.oos))), "|", fmt(stats(ts.filter((t) => t.oos))));
  }

  // The review study: does any condition at the signal pick out the winners
  // of the live rule (family A)? Each bucket, in-sample against out-of-sample.
  const a = results.get(FAMILIES[0]![0]) ?? [];
  console.log("\nreview study, family A — each condition at the signal");
  const keys = Object.keys(a[0]?.f ?? {});
  for (const key of keys) {
    const values = [...new Set(a.map((t) => t.f?.[key] ?? ""))].sort();
    for (const v of values) {
      const sel = a.filter((t) => t.f?.[key] === v);
      console.log(`  ${key} = ${v}`.padEnd(52), "|", fmt(stats(sel.filter((t) => !t.oos))), "|", fmt(stats(sel.filter((t) => t.oos))));
    }
  }
} finally {
  await client.close();
}
