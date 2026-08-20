/**
 * CORS for the dashboard (plan/22 §2).
 *
 * Shared by the long-lived server and the serverless app so the two cannot
 * drift — a difference between them would show up only in the browser, as a
 * request that works in one deployment and is blocked in the other.
 */

/**
 * Methods the control plane actually serves.
 *
 * This MUST be explicit. `@fastify/cors` v11 defaults to `GET,HEAD,POST`, so
 * `PATCH` and `DELETE` are absent unless named — and the failure is a nasty
 * one to read: the preflight still answers `204`, the browser then compares
 * the real method against `access-control-allow-methods`, finds it missing,
 * and blocks the request. DevTools reports "CORS error" with no response to
 * inspect, and the server logs nothing at all, because the request never
 * arrived. Saving settings and editing or deleting a strategy all failed this
 * way.
 *
 * Listed rather than widened to every verb: these are the methods the routes
 * use (see the control-plane route table), and nothing else needs allowing.
 */
export const CORS_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PATCH",
  "DELETE",
] as const;

/**
 * How long a browser may reuse one preflight result, in seconds.
 *
 * Without this the browser re-sends an `OPTIONS` before nearly every request —
 * Chrome's fallback is about five seconds — which doubles the request count and
 * adds a full round trip of latency to each call. On a page that fetches nine
 * read models, that is nine wasted round trips per navigation.
 *
 * Ten minutes is well inside Chrome's two-hour cap and short enough that a CORS
 * change takes effect without anyone clearing a cache. It only caches the
 * *permission* check; responses themselves are never cached by this.
 */
const PREFLIGHT_CACHE_SECONDS = 600;

export interface CorsConfig {
  origin: string;
  credentials: true;
  methods: string[];
  maxAge: number;
}

/**
 * Exactly one origin, never `*` — `credentials: true` forbids the wildcard,
 * and the dashboard must send the session cookie.
 */
export function corsOptions(dashboardOrigin: string): CorsConfig {
  return {
    origin: dashboardOrigin,
    credentials: true,
    methods: [...CORS_METHODS],
    maxAge: PREFLIGHT_CACHE_SECONDS,
  };
}
