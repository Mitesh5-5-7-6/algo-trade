import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "@neelkanth/logger";
import { buildServer, type ApiServer } from "../server.js";
import {
  registerResearchRelay,
  type ResearchRelayDeps,
} from "./research-relay.js";

const RESEARCH = {
  url: "https://research.example.com",
  token: "r".repeat(32),
};

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let app: ApiServer | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A trading server with only the relay on it, and what it sent upstream. */
function server(
  upstream: (seen: Seen) => Response | Promise<Response>,
  research: ResearchRelayDeps["research"] = RESEARCH,
): { app: ApiServer; seen: Seen[] } {
  const seen: Seen[] = [];
  app = buildServer({
    logger: createLogger({
      level: "fatal",
      name: "test",
      destination: {
        write() {
          return true;
        },
      },
    }),
    readinessChecks: [],
  });
  registerResearchRelay(app, {
    research,
    timeoutMs: 1_000,
    fetch: (async (input: URL | string, init?: RequestInit) => {
      const call: Seen = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: { ...(init?.headers as Record<string, string>) },
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      seen.push(call);
      return upstream(call);
    }) as typeof fetch,
  });
  return { app, seen };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("the relay to the research service (17.8)", () => {
  it("passes a plan on with the shared secret, and the answer back", async () => {
    const { app, seen } = server(() => json(200, { fingerprint: "abc" }));
    const plan = { symbol: "NSE:NIFTY50-INDEX", side: "LONG" };
    const response = await app.inject({
      method: "POST",
      url: "/research/odds",
      headers: { cookie: "session=operator-secret", "x-extra": "1" },
      payload: plan,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ fingerprint: "abc" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: "https://research.example.com/odds",
      method: "POST",
      body: JSON.stringify(plan),
    });
    // Its own secret goes across; nothing of the operator's does.
    expect(seen[0]?.headers).toEqual({
      authorization: `Bearer ${RESEARCH.token}`,
      "content-type": "application/json",
    });
  });

  it("asks what the store holds", async () => {
    const coverage = [{ symbol: "NSE:NIFTY50-INDEX", bars: 75 }];
    const { app, seen } = server(() => json(200, coverage));
    const response = await app.inject({
      method: "GET",
      url: "/research/odds/coverage",
    });
    expect(response.json()).toEqual(coverage);
    expect(seen[0]).toMatchObject({
      url: "https://research.example.com/odds/coverage",
      method: "GET",
      body: undefined,
    });
  });

  it("relays the scan and its coverage the same way (18.5)", async () => {
    const { app, seen } = server((call) =>
      json(200, { path: new URL(call.url).pathname }),
    );
    const scan = await app.inject({
      method: "POST",
      url: "/research/scan",
      headers: { cookie: "session=operator-secret" },
      payload: { date: "2026-11-17" },
    });
    expect(scan.json()).toEqual({ path: "/scan" });
    const coverage = await app.inject({
      method: "GET",
      url: "/research/scan/coverage",
    });
    expect(coverage.json()).toEqual({ path: "/scan/coverage" });
    expect(seen.map((s) => [s.method, s.url, s.body])).toEqual([
      ["POST", "https://research.example.com/scan", '{"date":"2026-11-17"}'],
      ["GET", "https://research.example.com/scan/coverage", undefined],
    ]);
    expect(seen[0]?.headers).toEqual({
      authorization: `Bearer ${RESEARCH.token}`,
      "content-type": "application/json",
    });
  });

  it("passes a refused plan back as the operator's to fix", async () => {
    const refusal = {
      error: {
        code: "VALIDATION_ERROR",
        message: "a long's stop must be below its entry",
      },
    };
    const { app } = server(() => json(400, refusal));
    const response = await app.inject({
      method: "POST",
      url: "/research/odds",
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(refusal);
  });

  it("says so, and asks nothing, when no research service is configured", async () => {
    const { app, seen } = server(() => json(200, {}), null);
    for (const request of [
      { method: "POST", url: "/research/odds", payload: {} },
      { method: "GET", url: "/research/odds/coverage" },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: {
          code: "RESEARCH_UNAVAILABLE",
          message: "the research service is not configured for this deployment",
        },
      });
    }
    expect(seen).toHaveLength(0);
  });

  it("answers 503 when the service is down, slow, or unreadable — and stays up", async () => {
    for (const upstream of [
      () => Promise.reject(new Error("ECONNREFUSED")),
      () => new Response("<html>bad gateway</html>", { status: 502 }),
    ]) {
      const { app } = server(upstream);
      const response = await app.inject({
        method: "POST",
        url: "/research/odds",
        payload: {},
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: "RESEARCH_UNAVAILABLE" },
      });
      // The server that relays is still answering.
      expect(
        (await app.inject({ method: "GET", url: "/health/live" })).statusCode,
      ).toBe(200);
      await app.close();
    }
  });

  it("names the platform's status when the answer is not JSON (2026-11-19)", async () => {
    const { app } = server(
      () => new Response("<html>bad gateway</html>", { status: 502 }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/research/scan",
      payload: {},
    });
    expect(response.json<{ error: { message: string } }>().error.message).toBe(
      "the research service gave an unreadable answer (HTTP 502, not JSON) — it may be restarting, or out of memory; see its logs",
    );
    await app.close();
  });

  it("never turns the service's refusal of its secret into a login prompt", async () => {
    const { app } = server(() =>
      json(401, { error: { code: "UNAUTHORIZED", message: "no" } }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/research/odds",
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: "RESEARCH_UNAVAILABLE",
        message: "the research service refused this deployment's credentials",
      },
    });
  });
});
