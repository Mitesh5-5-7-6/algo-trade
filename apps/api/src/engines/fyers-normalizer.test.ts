import { describe, expect, it } from "vitest";
import { fyersNormalizer } from "./fyers-normalizer.js";

/**
 * The boundary between the vendor SDK and our pipeline (plan/04 §4).
 *
 * These fixtures use the SDK's own mapped field names, taken from its
 * `HSM/mapper.js` — `ltp`, `vol_traded_today`, `exch_feed_time`,
 * `bid_price`/`ask_price`. The previous shape expected `bid`/`ask`, which the
 * SDK never emits, so quotes silently arrived without them.
 */
const fullTick = {
  symbol: "NSE:SBIN-EQ",
  type: "sf",
  ltp: 812.5,
  vol_traded_today: 1_000,
  exch_feed_time: 1_755_600_000,
  bid_price: 812.4,
  ask_price: 812.6,
};

describe("fyersNormalizer (SDK tick → internal Tick)", () => {
  it("maps a full-mode tick, bid/ask included", () => {
    const tick = fyersNormalizer({ ...fullTick, symbol: "NSE:A-EQ" });

    expect(tick).toMatchObject({
      symbol: "NSE:A-EQ",
      ltp: 812.5,
      bid: 812.4,
      ask: 812.6,
    });
  });

  it("converts the exchange feed time from seconds to milliseconds", () => {
    const tick = fyersNormalizer({ ...fullTick, symbol: "NSE:B-EQ" });
    expect(tick?.ts).toBe(1_755_600_000_000);
  });

  it("leaves a millisecond timestamp alone", () => {
    const tick = fyersNormalizer({
      ...fullTick,
      symbol: "NSE:C-EQ",
      exch_feed_time: 1_755_600_000_000,
    });
    expect(tick?.ts).toBe(1_755_600_000_000);
  });

  it("reports volume as the DELTA, not the running day total", () => {
    // vol_traded_today is cumulative; candles need per-tick volume.
    const first = fyersNormalizer({
      ...fullTick,
      symbol: "NSE:D-EQ",
      vol_traded_today: 1_000,
    });
    const second = fyersNormalizer({
      ...fullTick,
      symbol: "NSE:D-EQ",
      vol_traded_today: 1_250,
    });

    expect(first?.volume).toBe(0); // first sighting has no baseline
    expect(second?.volume).toBe(250);
  });

  it("never reports negative volume when the day total resets", () => {
    fyersNormalizer({ ...fullTick, symbol: "NSE:E-EQ", vol_traded_today: 900 });
    const afterReset = fyersNormalizer({
      ...fullTick,
      symbol: "NSE:E-EQ",
      vol_traded_today: 10,
    });
    expect(afterReset?.volume).toBe(0);
  });

  it("accepts a lite-mode tick, which carries no bid/ask", () => {
    const tick = fyersNormalizer({
      symbol: "NSE:F-EQ",
      type: "sf",
      ltp: 100.25,
      vol_traded_today: 5,
      exch_feed_time: 1_755_600_000,
    });

    expect(tick).toMatchObject({ symbol: "NSE:F-EQ", ltp: 100.25 });
    expect(tick?.bid).toBeUndefined();
    expect(tick?.ask).toBeUndefined();
  });

  it("still accepts the short raw-protocol aliases", () => {
    // `bp`/`sp`/`v` are the on-the-wire names the mapper renames. Accepting
    // both means a mapper change on the broker's side degrades to missing
    // fields, not to a dropped tick.
    const tick = fyersNormalizer({
      symbol: "NSE:G-EQ",
      ltp: 55,
      v: 10,
      bp: 54.9,
      sp: 55.1,
      exch_feed_time: 1_755_600_000,
    });

    expect(tick).toMatchObject({ bid: 54.9, ask: 55.1 });
  });

  it("rejects a message that is not a tick rather than inventing one", () => {
    expect(fyersNormalizer({ symbol: "NSE:H-EQ" })).toBeNull(); // no ltp
    expect(fyersNormalizer({ ltp: 5 })).toBeNull(); // no symbol
    expect(fyersNormalizer("not json")).toBeNull();
    expect(fyersNormalizer(null)).toBeNull();
  });

  it("parses a JSON string or Buffer payload", () => {
    const asString = fyersNormalizer(
      JSON.stringify({ ...fullTick, symbol: "NSE:I-EQ" }),
    );
    const asBuffer = fyersNormalizer(
      Buffer.from(JSON.stringify({ ...fullTick, symbol: "NSE:J-EQ" })),
    );

    expect(asString?.ltp).toBe(812.5);
    expect(asBuffer?.ltp).toBe(812.5);
  });
});
