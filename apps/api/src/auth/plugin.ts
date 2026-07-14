import type { UserRole } from "@neelkanth/core";
import type { UsersRepository } from "@neelkanth/db";
import type { ApiServer } from "../server.js";
import type { StepUpVerifier } from "../control-plane/controls.js";
import { StepUpRequiredError, UnauthorizedError } from "../errors.js";
import type { SessionStore } from "./sessions.js";
import { verifyPassword } from "./password.js";
import { SESSION_COOKIE, clearSessionCookie, readCookie } from "./cookie.js";

/** The authenticated operator attached to a request once the guard passes. */
export interface AuthUser {
  userId: string;
  sessionId: string;
  role: UserRole;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

export interface AuthGuardDeps {
  sessions: SessionStore;
  users: UsersRepository;
  /** Secure flag on cleared cookies — off in dev (plain HTTP), on in prod. */
  secureCookies: boolean;
}

/**
 * Requests exempt from the guard: the health probes (supervisors call them,
 * they expose no money state — plan/05 §4.1) and login itself (you can't be
 * authenticated to authenticate). Everything else — every read of money state,
 * every mutation — requires a live session (plan/21 §4).
 */
const PUBLIC_PATHS = new Set(["/health/live", "/health/ready", "/auth/login"]);

/**
 * The authentication guard (plan/21 §4): an `onRequest` hook that resolves the
 * session cookie to a live user before any handler runs. No cookie, unknown or
 * expired session, or an account that has since been disabled → 401, and the
 * handler never executes. Fails CLOSED — the money surface is unreachable
 * unless the operator is provably who they say (plan/21 §7). Re-checking the
 * user's status every request is deliberate: disabling an account kills its
 * live sessions on their next call, no revocation list needed.
 */
export function registerAuthGuard(app: ApiServer, deps: AuthGuardDeps): void {
  app.decorateRequest("authUser", undefined);

  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS") return;
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (PUBLIC_PATHS.has(pathname)) return;

    const sessionId = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (sessionId === undefined) {
      throw new UnauthorizedError("authentication required");
    }

    const session = await deps.sessions.resolve(sessionId);
    if (session === null) {
      reply.header("set-cookie", clearSessionCookie(deps.secureCookies));
      throw new UnauthorizedError("session expired or invalid");
    }

    const user = await deps.users.findById(session.userId);
    if (user === null || user.status !== "active") {
      // The session outlived the account (disabled/removed) — fail closed.
      await deps.sessions.destroy(sessionId);
      reply.header("set-cookie", clearSessionCookie(deps.secureCookies));
      throw new UnauthorizedError("account is not active");
    }

    request.authUser = { userId: user.userId, sessionId, role: user.role };
  });
}

/**
 * Build the step-up verifier (plan/21 §5) bound to the users repo. It confirms
 * a dangerous action by re-checking the operator's password — a hijacked but
 * idle session cannot re-enable trading or loosen limits without the actual
 * secret. Missing confirmation is a distinct 403 so the UI knows to prompt.
 */
export function createStepUpVerifier(users: UsersRepository): StepUpVerifier {
  return async (userId, password) => {
    if (userId === undefined) {
      throw new UnauthorizedError("authentication required");
    }
    if (password === undefined || password.length === 0) {
      throw new StepUpRequiredError("re-enter your password to confirm", {
        reason: "step_up_required",
      });
    }
    const user = await users.findById(userId);
    if (user === null) throw new UnauthorizedError("account not found");
    if (!(await verifyPassword(user.passwordHash, password))) {
      throw new StepUpRequiredError("step-up confirmation failed", {
        reason: "step_up_failed",
      });
    }
  };
}
