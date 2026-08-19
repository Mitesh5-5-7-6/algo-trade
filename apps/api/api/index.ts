/**
 * Vercel Serverless Function — the catch-all control-plane entrypoint.
 *
 * `vercel.json` rewrites every path that is not a static file or a more
 * specific function here, so `/positions`, `/orders`, `/control/pause`, the
 * whole surface, lands in this one handler and is dispatched by Fastify's own
 * router. That is the point: the routes are NOT reimplemented for serverless.
 * The same `registerControlPlane` / `registerAuthRoutes` the long-lived process
 * uses is mounted by `src/serverless/app.ts`, so there is exactly one
 * definition of every endpoint, one auth guard, one error envelope.
 *
 * Fastify is handed the raw `(req, res)` through its underlying Node server's
 * `request` event — the standard way to drive it without listening on a port.
 *
 * Read `src/serverless/app.ts` for what this deployment deliberately cannot do
 * (live engines, Socket.IO, background workers) before relying on it.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getApp } from "../src/serverless/app.js";

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let app;
  try {
    app = await getApp();
  } catch (error) {
    // A failed build means missing/bad configuration or unreachable infra —
    // there is no Fastify instance to render a proper envelope, so this is the
    // one place a response is written by hand. 503, not 500: the request was
    // fine; the dependency is not.
    console.error("control-plane bootstrap failed", error);
    res.statusCode = 503;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "control plane is not available",
        },
      }),
    );
    return;
  }

  // `app.ready()` has already been awaited during the build, so the router is
  // populated and this dispatch is synchronous from here.
  app.server.emit("request", req, res);
}
