import { describe, expect, it } from "vitest";
import type { OptionChainSnapshot } from "@neelkanth/core";
import { OptionChainArchiver } from "./option-chain-archiver.js";

const FIVE_MIN = 300_000;
/** 2026-11-30 09:15:00 IST. */
const T0 = Date.UTC(2026, 10, 30, 3, 45);

const snapshot = (underlying: string, asOf: number): OptionChainSnapshot => ({
  underlying,
  expiry: T0 + 86_400_000,
  asOf,
  spot: 25_800,
  rows: [{ strike: 25_800, callOI: 1, putOI: 1, callChangeOI: 0, putChangeOI: 0 }],
});

function harness(read?: (u: string, now: number) => Promise<OptionChainSnapshot | null>) {
  const kept: OptionChainSnapshot[] = [];
  const errors: unknown[] = [];
  let clock = T0;
  const archiver = new OptionChainArchiver({
    underlyings: ["NIFTY", "BANKNIFTY"],
    everyMs: FIVE_MIN,
    read: (u) => (read ? read(u, clock) : Promise.resolve(snapshot(u, clock))),
    keep: (s) => {
      kept.push(s);
      return Promise.resolve(true);
    },
    onError: (e) => errors.push(e),
  });
  const at = async (ms: number) => {
    clock = ms;
    await archiver.tick(ms);
  };
  return { at, kept, errors };
}

describe("OptionChainArchiver (14.23)", () => {
  it("keeps one snapshot per underlying per 5-minute slot", async () => {
    const h = harness();
    await h.at(T0); // 09:15:00
    await h.at(T0 + 20_000); // 09:15:20, same slot
    await h.at(T0 + 4 * 60_000); // 09:19, same slot
    await h.at(T0 + FIVE_MIN); // 09:20, next slot
    expect(h.kept.map((s) => s.underlying)).toEqual([
      "NIFTY",
      "BANKNIFTY",
      "NIFTY",
      "BANKNIFTY",
    ]);
  });

  it("survives a failed fetch and tries again in the next slot, not in a burst", async () => {
    let fail = true;
    const h = harness((u, now) =>
      fail && u === "NIFTY"
        ? Promise.reject(new Error("broker down"))
        : Promise.resolve(snapshot(u, now)),
    );
    await h.at(T0);
    await h.at(T0 + 30_000); // same slot: not retried
    expect(h.errors).toHaveLength(1);
    expect(h.kept.map((s) => s.underlying)).toEqual(["BANKNIFTY"]);
    fail = false;
    await h.at(T0 + FIVE_MIN);
    expect(h.kept.map((s) => s.underlying)).toEqual([
      "BANKNIFTY",
      "NIFTY",
      "BANKNIFTY",
    ]);
  });

  it("keeps nothing when the broker has no chain", async () => {
    const h = harness(() => Promise.resolve(null));
    await h.at(T0);
    expect(h.kept).toEqual([]);
    expect(h.errors).toEqual([]);
  });
});
