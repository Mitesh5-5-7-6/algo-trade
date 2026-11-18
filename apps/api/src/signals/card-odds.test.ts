import { describe, expect, it } from "vitest";
import type { TradeCard } from "@neelkanth/core";
import { oddsForCard, oddsPlanFor, type OddsBody } from "./card-odds.js";

/** 2026-11-18 10:30 IST. */
const TS = Date.UTC(2026, 10, 18, 5, 0);

const card = (over: Partial<TradeCard> = {}): TradeCard => ({
  signalId: "sig_1",
  strategyId: "str_orb",
  strategyName: "BANK NIFTY ORB",
  ts: TS,
  basis: "INDEX_SUGGESTED",
  underlying: "NSE:NIFTYBANK-INDEX",
  direction: "BULLISH",
  contract: "NSE:BANKNIFTY26NOV62100CE",
  optionType: "CE",
  strike: 62_100,
  expiry: null,
  lotSize: 30,
  action: "BUY",
  entry: 410,
  stopLoss: 360,
  target: 510,
  stopPoints: 50,
  targetPoints: 100,
  rewardRisk: 2,
  estimated: true,
  assumedDelta: 0.5,
  index: { entry: 62_100, stopLoss: 62_000, target: 62_300 },
  reason: "close above the opening-range high",
  note: null,
  ...over,
});

const ORB = { type: "ORB", params: { entryFromMinute: 45 } };
const INDICES = ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX"];

/** A research service answer, in its own shape. */
const ANSWER = {
  fingerprint: "f".repeat(64),
  manifest: { pool: { sessions: 279 } },
  result: {
    resampled: {
      replays: 10_000,
      targetFirst: 3_100,
      stopFirst: 6_200,
      neither: 700,
    },
    resampledVerdict: { breakEven: 1 / 3, verdict: "NEAR_BREAK_EVEN" },
    historyVerdict: {
      fired: 41,
      averageR: 0.12,
      verdict: "INSUFFICIENT_SAMPLE",
    },
  },
};

describe("a trade card's odds (2026-11-18)", () => {
  it("asks about an index strategy's own levels, at the signal's time, with its rule", () => {
    const planned = oddsPlanFor(card(), {
      spot: 62_105,
      rule: ORB,
      indexSymbols: INDICES,
    });
    expect(planned).toEqual({
      plan: {
        side: "LONG",
        entry: 62_100,
        stop: 62_000,
        target: 62_300,
        estimated: false,
      },
      body: {
        symbol: "NSE:NIFTYBANK-INDEX",
        side: "LONG",
        entry: 62_100,
        stop: 62_000,
        target: 62_300,
        date: "2026-11-18",
        time: "10:30",
        rule: ORB,
        indexSymbols: INDICES,
        save: false,
      },
    });
  });

  it("works an option strategy's premium levels back to the index, and says so", () => {
    const planned = oddsPlanFor(
      card({
        basis: "OPTION_STRATEGY",
        direction: "BEARISH",
        optionType: "PE",
        entry: 400,
        stopLoss: 300,
        target: 520,
        index: null,
      }),
      {
        spot: 62_000,
        rule: { type: "INDEX_OPTION_MOMENTUM", params: {} },
        indexSymbols: INDICES,
      },
    );
    if (!("body" in planned)) throw new Error("no plan");
    // A put: the premium losing 100 is the index rising 200; gaining 120, falling 240.
    expect(planned.plan).toEqual({
      side: "SHORT",
      entry: 62_000,
      stop: 62_200,
      target: 61_760,
      estimated: true,
    });
    // An option strategy's rule cannot be replayed on the index: odds only.
    expect(planned.body.rule).toBeUndefined();
  });

  it("does not ask what it cannot: a stock, missing levels, no live index price", () => {
    const stock = oddsPlanFor(card({ basis: "DIRECT", index: null }), {
      spot: null,
      rule: null,
      indexSymbols: [],
    });
    expect(stock).toMatchObject({
      status: "NOT_RUN",
      reason: expect.stringMatching(/index bars only/) as unknown,
    });
    expect(
      oddsPlanFor(
        card({ index: { entry: 62_100, stopLoss: null, target: 62_300 } }),
        {
          spot: null,
          rule: null,
          indexSymbols: [],
        },
      ),
    ).toMatchObject({ status: "NOT_RUN" });
    expect(
      oddsPlanFor(card({ basis: "OPTION_STRATEGY", index: null }), {
        spot: null,
        rule: null,
        indexSymbols: [],
      }),
    ).toMatchObject({
      status: "NOT_RUN",
      reason: expect.stringMatching(/no live price/) as unknown,
    });
  });

  it("keeps the service's numbers as shares of the replays, with the rule's history", async () => {
    const asked: OddsBody[] = [];
    const odds = await oddsForCard(
      card(),
      { spot: 62_100, rule: ORB, indexSymbols: INDICES },
      (body) => {
        asked.push(body);
        return Promise.resolve({ status: 200, body: ANSWER });
      },
    );
    expect(asked).toHaveLength(1);
    expect(odds).toEqual({
      status: "OK",
      reason: null,
      plan: {
        side: "LONG",
        entry: 62_100,
        stop: 62_000,
        target: 62_300,
        estimated: false,
      },
      replays: 10_000,
      sessions: 279,
      targetFirst: 0.31,
      stopFirst: 0.62,
      neither: 0.07,
      breakEven: 1 / 3,
      verdict: "NEAR_BREAK_EVEN",
      history: {
        rule: "ORB",
        fired: 41,
        averageR: 0.12,
        verdict: "INSUFFICIENT_SAMPLE",
      },
      fingerprint: "f".repeat(64),
    });
  });

  it("says so, in the service's words, when it refuses, fails or is not there — and never throws", async () => {
    const context = { spot: 62_100, rule: ORB, indexSymbols: INDICES };
    const refused = await oddsForCard(card(), context, () =>
      Promise.resolve({
        status: 400,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: "no full session before 2026-11-18",
          },
        },
      }),
    );
    expect(refused).toMatchObject({
      status: "UNAVAILABLE",
      reason:
        "the research service answered 400: no full session before 2026-11-18",
    });
    const down = await oddsForCard(card(), context, () =>
      Promise.reject(new Error("The operation was aborted due to timeout")),
    );
    expect(down).toMatchObject({
      status: "UNAVAILABLE",
      reason:
        "the research service did not answer: The operation was aborted due to timeout",
    });
    const none = await oddsForCard(card(), context, null);
    expect(none).toMatchObject({
      status: "NOT_RUN",
      reason: expect.stringMatching(/not configured/) as unknown,
    });
  });
});

describe("the research service client for card odds", () => {
  it("posts the plan with the shared secret and hands back status and body", async () => {
    const { researchOddsClient } = await import("./research-odds-client.js");
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const ask = researchOddsClient({
      url: "https://research.example.com",
      token: "t".repeat(32),
      fetch: ((input: URL | string, init?: RequestInit) => {
        seen.push({ url: String(input), init });
        return Promise.resolve(
          new Response(JSON.stringify(ANSWER), { status: 200 }),
        );
      }) as typeof fetch,
    });
    const planned = oddsPlanFor(card(), {
      spot: null,
      rule: ORB,
      indexSymbols: INDICES,
    });
    if (!("body" in planned)) throw new Error("no plan");
    const answer = await ask(planned.body);
    expect(answer).toEqual({ status: 200, body: ANSWER });
    expect(seen[0]?.url).toBe("https://research.example.com/odds");
    expect(seen[0]?.init?.method).toBe("POST");
    expect(seen[0]?.init?.headers).toEqual({
      authorization: `Bearer ${"t".repeat(32)}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(seen[0]?.init?.body as string)).toEqual(planned.body);
  });
});

describe("the card's odds in the message", () => {
  it("gives the odds, break-even and verdict, and the rule's history", async () => {
    const { formatCardOdds } = await import("./trade-card-message.js");
    const odds = await oddsForCard(
      card(),
      { spot: 62_100, rule: ORB, indexSymbols: INDICES },
      () => Promise.resolve({ status: 200, body: ANSWER }),
    );
    expect(formatCardOdds(odds)).toEqual([
      "Time Machine: target first 31% · stop first 62% · neither 7% (break-even 33%) — NEAR_BREAK_EVEN, 10,000 replays of 279 sessions",
      "ORB history: 41 trades, average 0.12R — INSUFFICIENT_SAMPLE",
    ]);
    expect(formatCardOdds(undefined)).toEqual([]);
    expect(
      formatCardOdds(
        await oddsForCard(
          card(),
          { spot: null, rule: null, indexSymbols: [] },
          null,
        ),
      ),
    ).toEqual([
      "Time Machine: not run — the research service is not configured for this deployment",
    ]);
  });
});
