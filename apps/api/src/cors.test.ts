import { describe, expect, it } from "vitest";
import cors from "@fastify/cors";
import { createLogger } from "@neelkanth/logger";
import { buildServer } from "./server.js";
import { corsOptions, CORS_METHODS } from "./cors.js";

const DASHBOARD = "https://dashboard.example.com";

/**
 * Driven through a real preflight rather than asserting on the options object,
 * because the bug this guards against lived in `@fastify/cors`'s default, not
 * in our config: v11 defaults to `GET,HEAD,POST`, so `PATCH` and `DELETE` were
 * silently absent from `access-control-allow-methods`.
 *
 * The failure is nearly unobservable from the server. The preflight still
 * answers 204, so the logs look clean; the browser then compares the real
 * method against the header, finds it missing, and blocks the request before
 * it is ever sent. Saving settings and editing or deleting a strategy all
 * failed this way, reported only as "CORS error" in DevTools.
 */
async function preflight(method: string) {
  const app = buildServer({
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
  await app.register(cors, corsOptions(DASHBOARD));
  const res = await app.inject({
    method: "OPTIONS",
    url: "/settings",
    headers: {
      origin: DASHBOARD,
      "access-control-request-method": method,
      "access-control-request-headers": "content-type",
    },
  });
  await app.close();
  return res;
}

describe("CORS preflight (plan/22 §2)", () => {
  it.each(["GET", "POST", "PATCH", "DELETE"])(
    "advertises %s as an allowed method",
    async (method) => {
      const res = await preflight(method);
      const allowed = String(res.headers["access-control-allow-methods"]);
      expect(allowed.split(",").map((m) => m.trim())).toContain(method);
    },
  );

  it("allows PATCH — the method that saves settings and edits a strategy", async () => {
    const res = await preflight("PATCH");
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toContain("PATCH");
  });

  it("allows DELETE — the method that removes a strategy", async () => {
    const res = await preflight("DELETE");
    expect(res.headers["access-control-allow-methods"]).toContain("DELETE");
  });

  it("echoes exactly one origin and never a wildcard", async () => {
    // `credentials: true` makes `*` invalid; the browser rejects the pair.
    const res = await preflight("GET");
    expect(res.headers["access-control-allow-origin"]).toBe(DASHBOARD);
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("allows credentials, so the session cookie is sent", async () => {
    const res = await preflight("GET");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("lets the browser cache the preflight, so every call is not doubled", async () => {
    // Absent, Chrome falls back to ~5s and re-preflights nearly every request:
    // nine read models per page becomes nine extra round trips per navigation.
    const res = await preflight("GET");
    const maxAge = Number(res.headers["access-control-max-age"]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(7200); // Chrome's cap; longer is ignored
  });

  it("keeps the shared method list as the single source of truth", () => {
    expect(corsOptions(DASHBOARD).methods).toEqual([...CORS_METHODS]);
    expect(corsOptions(DASHBOARD).origin).toBe(DASHBOARD);
  });
});
