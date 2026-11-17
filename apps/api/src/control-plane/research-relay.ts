import type { ApiServer } from "../server.js";

/** Where the research service answers, and the secret it is shown. */
export interface ResearchService {
  url: string;
  token: string;
}

export interface ResearchRelayDeps {
  /** Null when this deployment has no research service configured. */
  research: ResearchService | null;
  /** Injected for tests; the platform's `fetch` otherwise. */
  fetch?: typeof fetch;
  /** How long a relayed request may take. A year's history is seconds. */
  timeoutMs?: number;
}

const UNAVAILABLE = (message: string) => ({
  error: { code: "RESEARCH_UNAVAILABLE", message },
});

/**
 * The operator's way to the research service (design §6.1 D16).
 *
 * The dashboard is a static site holding one credential, the session cookie
 * for this API, and the research service is another origin that cookie is
 * never sent to. So the dashboard asks here, behind the same session guard as
 * every other route, and this relays the request with the shared secret.
 *
 * A relay and nothing more: no research code runs in this process and no
 * research database is opened by it — the work that replays a year of
 * sessions happens in the other process, off the event loop that carries
 * ticks and exits. If that process is down or not configured, these routes
 * say so with a 503 and nothing else here is affected (ADR §5.6).
 *
 * Only the request's JSON body goes across. The operator's cookie and
 * headers stay here.
 */
export function registerResearchRelay(
  app: ApiServer,
  deps: ResearchRelayDeps,
): void {
  const send = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 120_000;

  const relay = async (
    method: "GET" | "POST",
    path: string,
    body: unknown,
  ): Promise<{ status: number; payload: unknown }> => {
    if (deps.research === null)
      return {
        status: 503,
        payload: UNAVAILABLE(
          "the research service is not configured for this deployment",
        ),
      };
    let response: Response;
    try {
      response = await send(new URL(path, deps.research.url), {
        method,
        headers: {
          authorization: `Bearer ${deps.research.token}`,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return {
        status: 503,
        payload: UNAVAILABLE("the research service did not answer"),
      };
    }
    // Its own refusal of our secret is a misconfiguration here, not the
    // operator's session expiring: a 401 passed through would send the
    // dashboard to its login page.
    if (response.status === 401 || response.status === 403)
      return {
        status: 503,
        payload: UNAVAILABLE(
          "the research service refused this deployment's credentials",
        ),
      };
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        status: 503,
        payload: UNAVAILABLE("the research service gave an unreadable answer"),
      };
    }
    return { status: response.status, payload };
  };

  app.get("/research/odds/coverage", async (_request, reply) => {
    const { status, payload } = await relay("GET", "/odds/coverage", undefined);
    return reply.status(status).send(payload);
  });

  app.post("/research/odds", async (request, reply) => {
    const { status, payload } = await relay("POST", "/odds", request.body);
    return reply.status(status).send(payload);
  });

  // The pre-open scan (design §7.1 D8): the same relay, the same guard.
  app.get("/research/scan/coverage", async (_request, reply) => {
    const { status, payload } = await relay("GET", "/scan/coverage", undefined);
    return reply.status(status).send(payload);
  });

  app.post("/research/scan", async (request, reply) => {
    const { status, payload } = await relay("POST", "/scan", request.body);
    return reply.status(status).send(payload);
  });
}
