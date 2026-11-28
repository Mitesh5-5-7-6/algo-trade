/**
 * Pro lab (PLAN.md 14.22, 2026-11-28): (1) fix the payoff — exit variants on
 * the live Momentum rule's past signals; (2) the operator's professional
 * framework as a strategy — PDH/PDL breakouts and first pullbacks, 20 EMA,
 * RSI 60/40, ADX > 25, no chop, no first 15 minutes, no expiry afternoons,
 * stops on the index chart. Reads only.
 *
 *   node --env-file=../../.env.local scripts/pro-lab.mts [--db neelkanth_paper --from 2026-11-17]
 *
 * Same honesty as strategy-lab.mts: rules fixed before the run, in-sample the
 * first 60% of sessions, out-of-sample the rest, entry at the next bar's open,
 * a bar touching stop and target is the stop, an ATM option ≈ the index at
 * delta 0.5 with 0.02% costs and 0.02%/hour decay.
 *
 * Not testable here, stated in every report: option-chain OI (kept from
 * 2026-11-30, 14.23) and India VIX (not stored). VWAP needs volume the index
 * has not got; the session's average price so far stands in for it.
 */
import dns from "node:dns";
import { MongoClient } from "mongodb";

dns.setServers(["1.1.1.1"]);
const IST = 19_800_000;
const COST = Number(process.env.LAB_COST ?? 0.0002);
const DECAY_PER_HOUR = Number(process.env.LAB_DECAY ?? 0.0002);
const args = process.argv.slice(2);
const DB = args.includes("--db") ? args[args.indexOf("--db") + 1]! : "neelkanth_research";
const FROM = args.includes("--from") ? args[args.indexOf("--from") + 1]! : "0000";
const RECENT = DB !== "neelkanth_research";

interface Bar { ts: number; open: number; high: number; low: number; close: number }
interface Day { date: string; bars: Bar[]; prev: { high: number; low: number; close: number } | null; expiry: boolean }
interface Ind { ema20: number[]; rsi14: number[]; adx14: number[]; twap: number[] }
type Dir = 1 | -1;

const minuteOf = (ts: number) => Math.floor(((ts + IST) % 86_400_000) / 60_000);
const hm = (h: number, m: number) => h * 60 + m;

/** How a trade is managed after entry. */
interface ExitRules {
  stop: number; // hard stop price
  target?: number; // fixed target price
  structure?: { level: number }; // a 5m CLOSE back across this level exits at that close
  timeStop?: { minutes: number; minGainR: number }; // stalled: not +minGainR by then → out
  breakevenAtR?: number; // move the stop to entry once +R reached
  trailR?: number; // after breakeven, trail this many R behind the best close
}
interface Result { dir: Dir; entry: number; exit: number; heldMin: number; oos: boolean; why: string }

function manage(bars: Bar[], i: number, dir: Dir, rules: ExitRules, oos: boolean): Result | null {
  const first = bars[i + 1];
  if (first === undefined) return null;
  const entry = first.open;
  const risk = Math.abs(entry - rules.stop);
  if (risk <= 0 || dir * (entry - rules.stop) <= 0) return null; // opened through the stop
  let stop = rules.stop;
  let best = entry;
  for (let j = i + 1; j < bars.length; j += 1) {
    const b = bars[j]!;
    const held = minuteOf(b.ts) + 5 - minuteOf(first.ts);
    const out = (exit: number, why: string): Result => ({ dir, entry, exit, heldMin: held, oos, why });
    if (dir === 1 ? b.low <= stop : b.high >= stop) return out(stop, stop === rules.stop ? "stop" : "trail/breakeven");
    if (rules.target !== undefined && (dir === 1 ? b.high >= rules.target : b.low <= rules.target)) return out(rules.target, "target");
    if (rules.structure && dir * (b.close - rules.structure.level) < 0) return out(b.close, "structure");
    if (rules.timeStop && held >= rules.timeStop.minutes && dir * (b.close - entry) < rules.timeStop.minGainR * risk) return out(b.close, "time stop");
    if (minuteOf(b.ts) >= hm(15, 5)) return out(b.close, "square-off");
    best = dir === 1 ? Math.max(best, b.close) : Math.min(best, b.close);
    const gainR = (dir * (best - entry)) / risk;
    if (rules.breakevenAtR !== undefined && gainR >= rules.breakevenAtR && dir * (stop - entry) < 0) stop = entry;
    if (rules.trailR !== undefined && rules.breakevenAtR !== undefined && gainR >= rules.breakevenAtR) {
      const trail = best - dir * rules.trailR * risk;
      if (dir * (trail - stop) > 0) stop = trail;
    }
  }
  const last = bars.at(-1)!;
  return { dir, entry, exit: last.close, heldMin: minuteOf(last.ts) + 5 - minuteOf(first.ts), oos, why: "end" };
}

const net = (r: Result) => (r.dir * (r.exit - r.entry)) / r.entry - COST - (DECAY_PER_HOUR * r.heldMin) / 60;

function indicators(bars: Bar[], dayStarts: Set<number>): Ind {
  const n = bars.length;
  const ema20: number[] = [], rsi14: number[] = [], adx14: number[] = [], twap: number[] = [];
  const k = 2 / 21;
  let up = 0, down = 0, trS = 0, pdmS = 0, ndmS = 0, adx = 0, sum = 0, count = 0;
  for (let i = 0; i < n; i += 1) {
    const b = bars[i]!, p = bars[i - 1];
    ema20.push(i === 0 ? b.close : b.close * k + ema20[i - 1]! * (1 - k));
    if (dayStarts.has(i)) { sum = 0; count = 0; }
    sum += (b.high + b.low + b.close) / 3; count += 1; twap.push(sum / count);
    if (p === undefined) { rsi14.push(50); adx14.push(0); continue; }
    const ch = b.close - p.close;
    up = (up * 13 + Math.max(ch, 0)) / 14; down = (down * 13 + Math.max(-ch, 0)) / 14;
    rsi14.push(down === 0 ? 100 : 100 - 100 / (1 + up / down));
    const tr = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    const upMove = b.high - p.high, downMove = p.low - b.low;
    const pdm = upMove > downMove && upMove > 0 ? upMove : 0, ndm = downMove > upMove && downMove > 0 ? downMove : 0;
    trS = trS - trS / 14 + tr; pdmS = pdmS - pdmS / 14 + pdm; ndmS = ndmS - ndmS / 14 + ndm;
    const pdi = trS ? (100 * pdmS) / trS : 0, ndi = trS ? (100 * ndmS) / trS : 0;
    const dx = pdi + ndi ? (100 * Math.abs(pdi - ndi)) / (pdi + ndi) : 0;
    adx = (adx * 13 + dx) / 14; adx14.push(adx);
  }
  return { ema20, rsi14, adx14, twap };
}

/** NIFTY weekly expiry is Tuesday; BANKNIFTY's is the month's last Tuesday (NSE, from Sep 2025). */
function isExpiry(date: string, sym: string): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  if (d.getUTCDay() !== 2) return false;
  if (sym.includes("NIFTY50")) return true;
  const next = new Date(d.getTime() + 7 * 86_400_000);
  return next.getUTCMonth() !== d.getUTCMonth();
}

type Strategy = (day: Day, ind: Ind, off: number, oos: boolean) => Result[];

/** The live Momentum rule (N-bar breakout beyond the EMA), managed by `exits`. */
const momentum = (sym: string, exits: (dir: Dir, b: Bar, broken: number, entryGuess: number) => ExitRules): Strategy => (day, ind, off, oos) => {
  const nifty = sym.includes("NIFTY50");
  const N = nifty ? 10 : 8;
  const out: Result[] = [];
  let long = false, short = false;
  day.bars.forEach((b, i) => {
    const m = minuteOf(b.ts) + 5;
    if (m < hm(9, 35) || m > hm(14, 15) || i < N) return;
    const w = day.bars.slice(i - N, i);
    const hi = Math.max(...w.map((x) => x.high)), lo = Math.min(...w.map((x) => x.low));
    const e = ind.ema20[off + i]!;
    for (const dir of [1, -1] as Dir[]) {
      if (dir === 1 ? long || !(b.close > hi && b.close > e) : short || !(b.close < lo && b.close < e)) continue;
      if (dir === 1) long = true; else short = true;
      const r = manage(day.bars, i, dir, exits(dir, b, dir === 1 ? hi : lo, b.close), oos);
      if (r) out.push(r);
    }
  });
  return out;
};

/** The operator's professional framework: PDH/PDL with EMA, average price, RSI, ADX and the skips. */
const pro = (mode: "breakout" | "pullback", exits: (dir: Dir, entryBar: Bar, level: number, swing: number) => ExitRules): Strategy => (day, ind, off, oos) => {
  if (day.prev === null) return [];
  const out: Result[] = [];
  const taken = { 1: false, "-1": false } as Record<string, boolean>;
  const broke = { 1: false, "-1": false } as Record<string, boolean>;
  day.bars.forEach((b, i) => {
    const m = minuteOf(b.ts) + 5;
    if (m < hm(9, 30) || m > hm(14, 30) || i < 3) return; // no first 15 minutes; no late entries
    if (day.expiry && m >= hm(13, 30)) return; // no expiry afternoons
    const e = ind.ema20[off + i]!, rsi = ind.rsi14[off + i]!, adx = ind.adx14[off + i]!, avg = ind.twap[off + i]!;
    if (adx < 20) return; // chop: skip
    for (const dir of [1, -1] as Dir[]) {
      if (taken[dir]) continue;
      const level = dir === 1 ? day.prev!.high : day.prev!.low;
      const beyond = dir * (b.close - level) > 0;
      const trend = dir * (b.close - e) > 0 && dir * (b.close - avg) > 0;
      const momentumOk = dir === 1 ? rsi > 60 : rsi < 40;
      if (mode === "breakout") {
        if (!(beyond && trend && momentumOk && adx > 25)) continue;
        const prevBar = day.bars[i - 1]!;
        if (dir * (prevBar.close - level) > 0) continue; // only the bar that breaks
      } else {
        // First pullback: broke earlier, came back to within 0.1% of the level, closed back beyond it.
        if (beyond && trend && adx > 25) broke[dir] = broke[dir] || dir * (b.close - level) > level * 0.002;
        if (!broke[dir]) continue;
        const touched = dir === 1 ? b.low <= level * 1.001 : b.high >= level * 0.999;
        if (!(touched && beyond && trend)) continue;
      }
      taken[dir] = true;
      const swing = dir === 1 ? Math.min(...day.bars.slice(i - 2, i + 1).map((x) => x.low)) : Math.max(...day.bars.slice(i - 2, i + 1).map((x) => x.high));
      const r = manage(day.bars, i, dir, exits(dir, b, level, swing), oos);
      if (r) out.push(r);
    }
  });
  return out;
};

/**
 * Open-drive (from the charts of 17–27 Nov 2026): on every trend day the day's
 * low or high was made in the first 15–30 minutes and never revisited. By
 * `atMinute`, the index is `minMove` away from the open and has never been
 * back across it by more than 0.1%: enter in the drive's direction, stop just
 * beyond the open.
 */
const openDrive = (atMinute: number, minMove: number, exits: (dir: Dir, b: Bar, open: number) => ExitRules): Strategy => (day, _ind, _off, oos) => {
  const open = day.bars[0]?.open;
  if (open === undefined) return [];
  const i = day.bars.findIndex((b) => minuteOf(b.ts) + 5 === atMinute);
  if (i < 0) return [];
  const sofar = day.bars.slice(0, i + 1);
  const b = day.bars[i]!;
  for (const dir of [1, -1] as Dir[]) {
    const moved = (dir * (b.close - open)) / open >= minMove;
    const neverBack = dir === 1 ? Math.min(...sofar.map((x) => x.low)) >= open * 0.999 : Math.max(...sofar.map((x) => x.high)) <= open * 1.001;
    if (moved && neverBack) {
      const r = manage(day.bars, i, dir, exits(dir, b, open), oos);
      return r ? [r] : [];
    }
  }
  return [];
};
const driveExits = {
  "hold to 15:05, stop beyond the open": (dir: Dir, _b: Bar, open: number): ExitRules => ({ stop: open * (1 - dir * 0.001) }),
  "breakeven at 1R, trail 1R": (dir: Dir, _b: Bar, open: number): ExitRules => ({ stop: open * (1 - dir * 0.001), breakevenAtR: 1, trailR: 1 }),
  "2R target": (dir: Dir, b: Bar, open: number): ExitRules => { const stop = open * (1 - dir * 0.001); return { stop, target: b.close + dir * 2 * Math.abs(b.close - stop) }; },
};

// ---- exit variants ---------------------------------------------------------
const pct = (price: number, dir: Dir, p: number) => price * (1 - dir * p);
const momentumExits = (sym: string) => {
  const nifty = sym.includes("NIFTY50");
  const stopP = nifty ? 0.0039 : 0.0106, targetP = nifty ? 0.0094 : 0.0312;
  return {
    "X0 now: premium-% stop and target": (dir: Dir, _b: Bar, _lv: number, px: number): ExitRules => ({ stop: pct(px, dir, stopP), target: pct(px, dir, -targetP) }),
    "X1 + time stop (not +0.3R in 30 min)": (dir: Dir, _b: Bar, _lv: number, px: number): ExitRules => ({ stop: pct(px, dir, stopP), target: pct(px, dir, -targetP), timeStop: { minutes: 30, minGainR: 0.3 } }),
    "X2 + breakeven at 1R, trail 1R": (dir: Dir, _b: Bar, _lv: number, px: number): ExitRules => ({ stop: pct(px, dir, stopP), target: pct(px, dir, -targetP), breakevenAtR: 1, trailR: 1 }),
    "X3 chart stop: close back inside the breakout": (dir: Dir, b: Bar, lv: number, px: number): ExitRules => ({ stop: dir === 1 ? Math.min(b.low, pct(px, dir, stopP)) : Math.max(b.high, pct(px, dir, stopP)), target: pct(px, dir, -targetP), structure: { level: lv } }),
    "X4 chart stop + 2R target + trail": (dir: Dir, b: Bar, lv: number, px: number): ExitRules => { const stop = dir === 1 ? Math.min(b.low, lv) : Math.max(b.high, lv); return { stop, target: px + dir * 2 * Math.abs(px - stop), structure: { level: lv }, breakevenAtR: 1, trailR: 1 }; },
  };
};
const proExits = {
  "P1 chart stop (close back inside PDH/PDL), 2R target": (dir: Dir, b: Bar, lv: number, swing: number): ExitRules => { const stop = dir === 1 ? Math.min(b.low, swing) : Math.max(b.high, swing); return { stop, target: b.close + dir * 2 * Math.abs(b.close - stop), structure: { level: lv } }; },
  "P2 chart stop, breakeven at 1R, trail 1R": (dir: Dir, b: Bar, lv: number, swing: number): ExitRules => { const stop = dir === 1 ? Math.min(b.low, swing) : Math.max(b.high, swing); return { stop, structure: { level: lv }, breakevenAtR: 1, trailR: 1 }; },
  "P3 chart stop, 3R target, time stop 45 min": (dir: Dir, b: Bar, lv: number, swing: number): ExitRules => { const stop = dir === 1 ? Math.min(b.low, swing) : Math.max(b.high, swing); return { stop, target: b.close + dir * 3 * Math.abs(b.close - stop), structure: { level: lv }, timeStop: { minutes: 45, minGainR: 0.3 } }; },
};

// ---- run ---------------------------------------------------------------------
const client = new MongoClient(process.env.MONGO_URI ?? "");
await client.connect();
try {
  const db = client.db(DB);
  const all = new Map<string, Result[]>();
  const add = (name: string, rs: Result[]) => all.set(name, [...(all.get(name) ?? []), ...rs]);
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
    let prev: Day["prev"] = null;
    for (const [date, bars] of [...byDay.entries()].sort()) {
      if (bars.length < 60) continue;
      if (date >= FROM) days.push({ date, bars, prev, expiry: isExpiry(date, sym) });
      prev = { high: Math.max(...bars.map((b) => b.high)), low: Math.min(...bars.map((b) => b.low)), close: bars.at(-1)!.close };
    }
    const flat = days.flatMap((d) => d.bars);
    const starts = new Set<number>();
    let o = 0;
    for (const d of days) { starts.add(o); o += d.bars.length; }
    const ind = indicators(flat, starts);
    const split = RECENT ? days.length : Math.floor(days.length * 0.6);
    console.log(`${sym}: ${String(days.length)} sessions ${days[0]?.date} → ${days.at(-1)?.date}${RECENT ? "" : `; out-of-sample from ${days[split]?.date}`}`);
    const strategies: [string, Strategy][] = [
      ...Object.entries(momentumExits(sym)).map(([n, ex]) => [`A ${n}`, momentum(sym, ex)] as [string, Strategy]),
      ...Object.entries(proExits).map(([n, ex]) => [`PRO breakout · ${n}`, pro("breakout", ex)] as [string, Strategy]),
      ...Object.entries(proExits).map(([n, ex]) => [`PRO first pullback · ${n}`, pro("pullback", ex)] as [string, Strategy]),
      ...[[hm(9, 45), 0.003], [hm(9, 45), 0.005], [hm(10, 0), 0.003], [hm(10, 0), 0.005]].flatMap(([at, mv]) =>
        Object.entries(driveExits).map(([n, ex]) => [`DRIVE ${String(Math.floor(at! / 60))}:${String(at! % 60).padStart(2, "0")} ${(mv! * 100).toFixed(1)}% · ${n}`, openDrive(at!, mv!, ex)] as [string, Strategy])),
    ];
    for (const [name, s] of strategies) {
      let off = 0;
      days.forEach((day, k) => { add(name, s(day, ind, off, k >= split)); off += day.bars.length; });
    }
  }
  const stats = (rs: Result[]) => {
    const n = rs.map(net), w = n.filter((x) => x > 0), l = n.filter((x) => x <= 0);
    const g = w.reduce((a, b) => a + b, 0), lo = -l.reduce((a, b) => a + b, 0);
    return `${String(rs.length).padStart(4)} tr  win ${(rs.length ? (w.length / rs.length) * 100 : 0).toFixed(0).padStart(3)}%  avg ${((n.reduce((a, b) => a + b, 0) / (rs.length || 1)) * 100).toFixed(3).padStart(7)}%  win/loss ${(w.length ? (g / w.length) * 100 : 0).toFixed(2)}/${(l.length ? (lo / l.length) * 100 : 0).toFixed(2)}  PF ${(lo > 0 ? g / lo : 0).toFixed(2)}`;
  };
  console.log(`\nstrategy · exit${" ".repeat(48)}| ${RECENT ? "recent sessions" : "in-sample"}${" ".repeat(46)}${RECENT ? "" : "| OUT-OF-SAMPLE"}`);
  for (const [name, rs] of all) {
    console.log(name.slice(0, 64).padEnd(64), "|", stats(rs.filter((r) => !r.oos)), RECENT ? "" : `| ${stats(rs.filter((r) => r.oos))}`);
  }
} finally {
  await client.close();
}
