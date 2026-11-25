import {
  CHECKPOINT_MOVE_GRID,
  type Candle,
  type CheckpointOddsRow,
  type CheckpointOddsTable,
} from "@neelkanth/core";

const IST_OFFSET_MS = 19_800_000;
const SESSION_OPEN_MINUTE = 9 * 60 + 15;
const DAY_MS = 86_400_000;

/**
 * The three-part target's odds table (PLAN.md 14.17), from stored bars.
 *
 * The question a checkpoint asks: from here, does the index move a further
 * `m` in my direction before it comes back `back × m` (the stop, moved to the
 * entry)? For every bar of every stored session, from its close, scanned
 * forward through the same session only. A bar that reaches both is counted
 * as the stop first — the cautious reading, as the Exit Engine's.
 *
 * Grouped by index, direction, hour of the session, move size and `back`
 * (1 at T1 → T2, 2 at T2 → T3). Pure: bars in, table out.
 */
export function buildCheckpointOdds(
  bars: readonly Candle[],
  now: number,
): CheckpointOddsTable {
  const counts = new Map<string, { hits: number; samples: number }>();
  const sessions = new Set<string>();

  const bySymbolDay = new Map<string, Candle[]>();
  for (const bar of bars) {
    const day = Math.floor((bar.ts + IST_OFFSET_MS) / DAY_MS);
    const key = `${bar.symbol}|${String(day)}`;
    let list = bySymbolDay.get(key);
    if (list === undefined) {
      list = [];
      bySymbolDay.set(key, list);
    }
    list.push(bar);
  }

  for (const [key, list] of bySymbolDay) {
    const [symbol = ""] = key.split("|");
    list.sort((a, b) => a.ts - b.ts);
    sessions.add(key);
    for (let i = 0; i < list.length - 1; i += 1) {
      const start = list[i];
      if (start === undefined) continue;
      const minuteOfDay = Math.floor(
        ((start.ts + IST_OFFSET_MS) % DAY_MS) / 60_000,
      );
      const fromMinute =
        Math.floor(Math.max(0, minuteOfDay + 5 - SESSION_OPEN_MINUTE) / 60) *
        60;
      for (const move of CHECKPOINT_MOVE_GRID)
        for (const back of [1, 2])
          for (const direction of ["UP", "DOWN"] as const) {
            const hit = reachesFirst(list, i, start.close, move, back, direction);
            if (hit === null) continue; // neither by the close: not a case
            const k = `${symbol}|${direction}|${String(fromMinute)}|${String(move)}|${String(back)}`;
            const c = counts.get(k) ?? { hits: 0, samples: 0 };
            c.samples += 1;
            if (hit) c.hits += 1;
            counts.set(k, c);
          }
    }
  }

  const rows: CheckpointOddsRow[] = [];
  for (const [k, c] of counts) {
    const [underlying = "", direction, fromMinute, movePct, back] = k.split("|");
    rows.push({
      underlying,
      direction: direction === "UP" ? "UP" : "DOWN",
      fromMinute: Number(fromMinute),
      movePct: Number(movePct),
      back: Number(back),
      samples: c.samples,
      chance: Math.round((c.hits / c.samples) * 10_000) / 10_000,
    });
  }
  rows.sort(
    (a, b) =>
      a.underlying.localeCompare(b.underlying) ||
      a.direction.localeCompare(b.direction) ||
      a.fromMinute - b.fromMinute ||
      a.back - b.back ||
      a.movePct - b.movePct,
  );
  return { builtAt: now, sessions: sessions.size, rows };
}

/** True: the move on came first; false: the move back; null: neither. */
function reachesFirst(
  bars: readonly Candle[],
  from: number,
  price: number,
  move: number,
  back: number,
  direction: "UP" | "DOWN",
): boolean | null {
  const sign = direction === "UP" ? 1 : -1;
  const on = price * (1 + sign * move);
  const stop = price * (1 - sign * move * back);
  for (let j = from + 1; j < bars.length; j += 1) {
    const bar = bars[j];
    if (bar === undefined) continue;
    const stopped = direction === "UP" ? bar.low <= stop : bar.high >= stop;
    if (stopped) return false;
    const reached = direction === "UP" ? bar.high >= on : bar.low <= on;
    if (reached) return true;
  }
  return null;
}
