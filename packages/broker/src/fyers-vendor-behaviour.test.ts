import { describe, expect, it } from "vitest";
import { FyersHistoryProvider } from "./fyers-history.js";
import { HistoryFetchError } from "./history-provider.js";

/**
 * Task 1.9 — vendor-specific behaviour, pinned to what was MEASURED.
 *
 * Every response body below is the real shape recorded by the §10.1 probe
 * against account YM14932 on 2026-09-28, not an invention. That is the whole
 * value of this file: the generic rules in §5 hold for any provider, while
 * these are the three things only FYERS could tell us, and they are the ones
 * most likely to be silently wrong if anyone ever re-derives them from
 * intuition.
 *
 * If FYERS changes any of these, this file is where it breaks — deliberately,
 * and with the measurement date attached, rather than somewhere downstream
 * where the symptom is a short dataset.
 */

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const ist = (y: number, mo: number, d: number, h: number, mi: number): number =>
  Date.UTC(y, mo, d, h, mi) - IST_OFFSET_MS;

const FRIDAY_OPEN = ist(2026, 0, 9, 9, 15);

function provider(
  respond: () => Response,
  overrides: Partial<{ maxDaysPerRequest: number }> = {},
): FyersHistoryProvider {
  return new FyersHistoryProvider({
    appId: "APP-100",
    getToken: () => Promise.resolve("tok"),
    maxDaysPerRequest: overrides.maxDaysPerRequest ?? 100,
    requestDelayMs: 0,
    maxRetries: 0,
    now: () => 1_760_000_000_000,
    fetch: () => Promise.resolve(respond()),
  });
}

const request = {
  symbol: "NSE:NIFTY50-INDEX",
  interval: "5m" as const,
  fromTs: FRIDAY_OPEN,
  toTs: FRIDAY_OPEN + 6 * 3_600_000,
};

describe("a non-trading day is a SUCCESSFUL response (Q5, measured)", () => {
  /**
   * The exact body a Saturday returns. HTTP 200 — never a 4xx — with the
   * vendor's own `no_data` status and an empty array.
   *
   * This single fact is what the MARKET_CLOSED / DATA_MISSING / API_FAILURE
   * split rests on. If a closed day were an error, a holiday and a broken
   * token would be indistinguishable and the calendar work would be guesswork
   * dressed up as classification.
   */
  const SATURDAY_BODY = {
    candles: [],
    code: 200,
    message: "",
    nextTime: 1790330100,
    s: "no_data",
  };

  it("reports empty rather than throwing", async () => {
    const result = await provider(
      () => new Response(JSON.stringify(SATURDAY_BODY), { status: 200 }),
    ).getHistory(request);

    expect(result.empty).toBe(true);
    expect(result.candles).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  /**
   * An empty range is not a truncated one. Flagging it would mark every
   * closed period as a suspected vendor cap, and the flag would stop meaning
   * anything.
   */
  it("does not mistake it for a truncated response", async () => {
    const result = await provider(
      () => new Response(JSON.stringify(SATURDAY_BODY), { status: 200 }),
    ).getHistory(request);

    expect(result.coverage.truncated).toBe(false);
  });

  /** `nextTime` is undocumented; it must not be read as data. */
  it("ignores the undocumented nextTime field", async () => {
    const result = await provider(
      () => new Response(JSON.stringify(SATURDAY_BODY), { status: 200 }),
    ).getHistory(request);

    expect(result.candles).toEqual([]);
    expect(result.pagesFetched).toBe(1);
  });

  it("treats a bare no_data with no other fields the same way", async () => {
    const result = await provider(
      () => new Response(JSON.stringify({ s: "no_data" }), { status: 200 }),
    ).getHistory(request);

    expect(result.empty).toBe(true);
  });
});

describe("an over-long range is refused, not truncated (Q1, measured)", () => {
  /**
   * 100 days succeed; 150 returns HTTP 422 with no body at all. The vendor
   * offers no message and no documented code, so the interpretation has to
   * come from our side — otherwise an operator reads "HTTP 422" and goes
   * looking at credentials or the network when the fix is one number.
   */
  it("names the page size as the cause", async () => {
    const error = await provider(
      () => new Response("", { status: 422 }),
      { maxDaysPerRequest: 150 },
    )
      .getHistory(request)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HistoryFetchError);
    expect((error as HistoryFetchError).message).toContain("too large");
    expect((error as HistoryFetchError).message).toContain("150");
    expect((error as HistoryFetchError).message).toContain("100 days");
  });

  /** Asking again with the same page size gets the same refusal. */
  it("does not retry it", async () => {
    let calls = 0;
    const p = new FyersHistoryProvider({
      appId: "APP-100",
      getToken: () => Promise.resolve("tok"),
      maxDaysPerRequest: 150,
      requestDelayMs: 0,
      maxRetries: 5,
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response("", { status: 422 }));
      },
    });

    await expect(p.getHistory(request)).rejects.toMatchObject({
      retryable: false,
      status: 422,
    });
    expect(calls).toBe(1);
  });

  /**
   * The refusal is total — no partial data comes back with it. Worth pinning:
   * a future vendor change to "200 plus a short array" is exactly the silent
   * truncation `coverage` exists to catch, and this test failing is the
   * signal that the kinder behaviour has gone away.
   */
  it("carries no candles with the refusal", async () => {
    const result = await provider(
      () => new Response("", { status: 422 }),
      { maxDaysPerRequest: 150 },
    )
      .getHistory(request)
      .then(
        () => "resolved",
        () => "threw",
      );

    expect(result).toBe("threw");
  });
});

describe("index volume is real (Q4, measured)", () => {
  /**
   * The measurement that overturned an assumption: NSE:NIFTY50-INDEX returned
   * 74 of 75 bars with non-zero volume, a profile indistinguishable from an
   * equity, with 10,817,533 on the opening bar. Had the common claim that
   * index volume is always zero been taken on trust, a usable column would
   * have been discarded across the entire research dataset.
   *
   * These are the first two real bars of 2026-09-25.
   */
  const REAL_INDEX_BARS = [
    [1790307900, 23035, 23104.4, 23030, 23074.3, 10817533],
    [1790308200, 23074.3, 23090, 23050.1, 23061.5, 8241002],
  ];

  it("keeps a real index volume instead of discarding it", async () => {
    const p = new FyersHistoryProvider({
      appId: "APP-100",
      getToken: () => Promise.resolve("tok"),
      maxDaysPerRequest: 100,
      requestDelayMs: 0,
      now: () => 1_760_000_000_000,
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ s: "ok", candles: REAL_INDEX_BARS })),
        ),
    });

    const first = REAL_INDEX_BARS[0]?.[0] ?? 0;
    const result = await p.getHistory({
      symbol: "NSE:NIFTY50-INDEX",
      interval: "5m",
      fromTs: first * 1000,
      toTs: first * 1000 + 3_600_000,
    });

    expect(result.candles).toHaveLength(2);
    expect(result.candles[0]?.volume).toBe(10_817_533);
    expect(result.candles[1]?.volume).toBe(8_241_002);
  });

  /**
   * Q4 is answered, so nothing should be marking these SUSPECT any more once
   * the operator says the symbol has real volume — and the default must not
   * quietly zero them out.
   */
  it("does not treat a measured index as volume-unavailable by default", async () => {
    const p = new FyersHistoryProvider({
      appId: "APP-100",
      getToken: () => Promise.resolve("tok"),
      maxDaysPerRequest: 100,
      requestDelayMs: 0,
      symbolHasRealVolume: true,
      now: () => 1_760_000_000_000,
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ s: "ok", candles: REAL_INDEX_BARS })),
        ),
    });

    const first = REAL_INDEX_BARS[0]?.[0] ?? 0;
    const result = await p.getHistory({
      symbol: "NSE:NIFTY50-INDEX",
      interval: "5m",
      fromTs: first * 1000,
      toTs: first * 1000 + 3_600_000,
    });

    expect(result.candles[0]?.volumeAvailable).toBe(true);
    expect(result.candles[0]?.volumeQuality).toBe("REAL");
  });

  /**
   * A full session is 75 five-minute bars (09:15 through 15:25 inclusive).
   * The probe returned exactly that for every day it asked about, which is
   * the cheapest available check that a day came back whole.
   */
  it("accepts a full 75-bar session without rejecting any bar", async () => {
    const sessionStart = 1790307900; // 2026-09-25 09:15 IST, epoch seconds
    const bars = Array.from({ length: 75 }, (_, i) => [
      sessionStart + i * 300,
      23000,
      23010,
      22990,
      23005,
      1_000_000,
    ]);

    const p = new FyersHistoryProvider({
      appId: "APP-100",
      getToken: () => Promise.resolve("tok"),
      maxDaysPerRequest: 100,
      requestDelayMs: 0,
      now: () => 1_760_000_000_000,
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ s: "ok", candles: bars }))),
    });

    const result = await p.getHistory({
      symbol: "NSE:NIFTY50-INDEX",
      interval: "5m",
      fromTs: sessionStart * 1000,
      toTs: (sessionStart + 75 * 300) * 1000,
    });

    expect(result.candles).toHaveLength(75);
    expect(result.rejected).toEqual([]);
    expect(result.coverage.truncated).toBe(false);
  });
});

describe("an expired token is not retried (measured)", () => {
  /**
   * The real 401 body, seen while diagnosing a token minted for the wrong
   * app. Retrying spends rate-limit budget on a call that cannot succeed
   * until a human intervenes.
   */
  it("fails immediately on 'Could not authenticate the user'", async () => {
    let calls = 0;
    const p = new FyersHistoryProvider({
      appId: "APP-100",
      getToken: () => Promise.resolve("tok"),
      maxDaysPerRequest: 100,
      requestDelayMs: 0,
      maxRetries: 3,
      fetch: () => {
        calls += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              code: -16,
              message: "Could not authenticate the user",
              s: "error",
            }),
            { status: 401 },
          ),
        );
      },
    });

    await expect(p.getHistory(request)).rejects.toMatchObject({
      retryable: false,
      status: 401,
    });
    expect(calls).toBe(1);
  });
});
