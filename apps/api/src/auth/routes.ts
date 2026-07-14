import { z, type ZodType } from "zod";
import type { UsersRepository } from "@neelkanth/db";
import type { ApiServer } from "../server.js";
import {
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from "../errors.js";
import type { SessionStore } from "./sessions.js";
import type { LoginRateLimiter } from "./rate-limit.js";
import { verifyPassword } from "./password.js";
import { SESSION_IDLE_TTL_SECONDS } from "./config.js";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  readCookie,
  serializeSessionCookie,
} from "./cookie.js";

function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError("invalid request", {
      issues: result.error.issues,
    });
  }
  return result.data;
}

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export interface AuthRoutesDeps {
  users: UsersRepository;
  sessions: SessionStore;
  rateLimiter: LoginRateLimiter;
  secureCookies: boolean;
}

/**
 * The login/logout surface (plan/21 §2-3). Login is the one place a password is
 * ever checked. It is deliberately uniform on failure — the response never
 * reveals whether the email exists — and rate-limited per-account AND per-IP so
 * neither targeted nor sprayed brute force gets many tries. Success rotates a
 * fresh session id (fixation defense, plan/21 §3) into an HttpOnly cookie.
 */
export function registerAuthRoutes(app: ApiServer, deps: AuthRoutesDeps): void {
  app.post("/auth/login", async (request, reply) => {
    const body = parse(LoginBody, request.body);
    const email = body.email.toLowerCase();
    const ip = request.ip;

    if (
      (await deps.rateLimiter.isLocked(email)) ||
      (await deps.rateLimiter.isLocked(ip))
    ) {
      throw new RateLimitError("too many attempts — try again later");
    }

    const user = await deps.users.findByEmail(email);
    const ok =
      user !== null &&
      user.status === "active" &&
      (await verifyPassword(user.passwordHash, body.password));
    if (!ok) {
      await deps.rateLimiter.recordFailure(email);
      await deps.rateLimiter.recordFailure(ip);
      // Uniform message — never reveal whether the email exists (plan/21 §2).
      throw new UnauthorizedError("invalid credentials");
    }

    await deps.rateLimiter.reset(email);
    await deps.rateLimiter.reset(ip);
    const sessionId = await deps.sessions.create(user.userId);
    await deps.users.recordLogin(user.userId, Date.now());
    reply.header(
      "set-cookie",
      serializeSessionCookie(sessionId, {
        maxAgeSeconds: SESSION_IDLE_TTL_SECONDS,
        secure: deps.secureCookies,
      }),
    );
    return { userId: user.userId, email: user.email, role: user.role };
  });

  app.post("/auth/logout", async (request, reply) => {
    const sessionId = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (sessionId !== undefined) await deps.sessions.destroy(sessionId);
    reply.header("set-cookie", clearSessionCookie(deps.secureCookies));
    return { ok: true };
  });
}
