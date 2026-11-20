"use client";

import { useEffect, useState } from "react";
import { price, progress } from "@/lib/trade-card";

/** The current time, refreshed every `ms`, so "5s ago" keeps counting. */
export function useNow(ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, ms);
    return () => {
      clearInterval(timer);
    };
  }, [ms]);
  return now;
}

/**
 * Stop on the left, target on the right, the entry marked, and a dot where the
 * live price is (2026-11-20). The fill runs from the entry to the price: green
 * toward the target, red toward the stop.
 */
export function LevelBar({
  stop,
  entry,
  target,
  ltp,
}: {
  stop: number | null | undefined;
  entry: number;
  target: number | null | undefined;
  ltp: number | null | undefined;
}) {
  const at = progress(ltp, stop, target);
  const from = progress(entry, stop, target);
  if (at === null || from === null)
    return <span className="hint">no stop or target</span>;
  const gaining = at >= from;
  const left = Math.min(at, from) * 100;
  const width = Math.abs(at - from) * 100;
  return (
    <div
      className="level-bar"
      title={`stop ${price(stop ?? null)} · entry ${price(entry)} · target ${price(target ?? null)}`}
    >
      <div className="level-track">
        <div
          className={`level-fill ${gaining ? "up" : "down"}`}
          style={{ left: `${String(left)}%`, width: `${String(width)}%` }}
        />
        <div
          className="level-entry"
          style={{ left: `${String(from * 100)}%` }}
        />
        <div
          className={`level-dot ${gaining ? "up" : "down"}`}
          style={{ left: `${String(at * 100)}%` }}
        />
      </div>
      <div className="level-labels">
        <span className="neg">SL {price(stop ?? null)}</span>
        <span className="pos">T {price(target ?? null)}</span>
      </div>
    </div>
  );
}
