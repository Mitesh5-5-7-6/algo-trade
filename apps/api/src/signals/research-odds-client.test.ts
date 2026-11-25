import { describe, expect, it } from "vitest";
import { researchOddsClient } from "./research-odds-client.js";
import type { OddsBody } from "./card-odds.js";

const BODY: OddsBody = {
  symbol: "NSE:NIFTY50-INDEX",
  side: "LONG",
  entry: 100,
  stop: 90,
  target: 120,
  date: "2026-11-25",
  time: "11:40",
  indexSymbols: [],
  save: false,
};

function scripted(responses: Response[]) {
  const calls: string[] = [];
  const fetch = (url: string | URL | Request): Promise<Response> => {
    calls.push(url instanceof Request ? url.url : url.toString());
    const next = responses.shift();
    if (next === undefined) throw new Error("no more responses");
    return Promise.resolve(next);
  };
  return { fetch, calls };
}

const platform429 = () =>
  new Response("<html><body>Too Many Requests</body></html>", {
    status: 429,
    headers: { server: "cloudflare", "rndr-id": "abc", "retry-after": "1" },
  });

describe("researchOddsClient", () => {
  it("retries a platform 429 and returns the answer that follows", async () => {
    const waits: number[] = [];
    const { fetch, calls } = scripted([
      platform429(),
      new Response(JSON.stringify({ result: "ok" }), { status: 200 }),
    ]);
    const ask = researchOddsClient({
      url: "https://research.example",
      token: "t",
      fetch,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    const answer = await ask(BODY);
    expect(answer).toEqual({ status: 200, body: { result: "ok" } });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([1000]); // the platform's Retry-After
  });

  it("gives up after its attempts and says who refused", async () => {
    const { fetch, calls } = scripted([
      platform429(),
      platform429(),
      platform429(),
    ]);
    const ask = researchOddsClient({
      url: "https://research.example",
      token: "t",
      fetch,
      sleep: () => Promise.resolve(),
    });
    const answer = await ask(BODY);
    expect(calls).toHaveLength(3);
    expect(answer.status).toBe(429);
    const message = (answer.body as { error: { message: string } }).error
      .message;
    expect(message).toContain("server=cloudflare");
    expect(message).toContain("rndr-id=abc");
    expect(message).toContain("Too Many Requests");
  });

  it("does not retry the service's own refusal", async () => {
    const { fetch, calls } = scripted([
      new Response(JSON.stringify({ error: { message: "bad plan" } }), {
        status: 400,
      }),
    ]);
    const ask = researchOddsClient({
      url: "https://research.example",
      token: "t",
      fetch,
      sleep: () => Promise.resolve(),
    });
    const answer = await ask(BODY);
    expect(calls).toHaveLength(1);
    expect(answer).toEqual({
      status: 400,
      body: { error: { message: "bad plan" } },
    });
  });
});
