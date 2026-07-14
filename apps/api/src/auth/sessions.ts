import { randomBytes } from "node:crypto";
import { z } from "zod";
import { authSessionKey, authUserSessionsKey } from "@neelkanth/redis";

/**
 * The subset of Redis this needs, as a port (plan/05 §3) — so the store is
 * unit-testable against an in-memory fake, and the composition root injects the
 * real client. `set` carries the TTL because a session's whole security model
 * is "it expires" (plan/21 §3).
 */
export interface SessionKV {
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
  sadd(key: string, member: string): Promise<void>;
  srem(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<string[]>;
}

const SessionRecordSchema = z.object({
  userId: z.string(),
  createdAt: z.number(),
  /** Hard ceiling on lifetime; idle TTL refreshes never push past this. */
  absoluteExpiry: z.number(),
});

export interface ResolvedSession {
  sessionId: string;
  userId: string;
}

/**
 * Server-side sessions (plan/21 §3), NOT JWTs. The point is revocability: a
 * session lives only in Redis, so logout, lockout, or password change is a
 * single delete and the credential is dead immediately. The id is an opaque
 * 256-bit random token — it carries no claims, it is only a lookup key.
 */
export class SessionStore {
  constructor(
    private readonly kv: SessionKV,
    /** Idle TTL, refreshed on each activity (sliding window). */
    private readonly idleTtlSeconds: number,
    /** Absolute max lifetime regardless of activity (plan/21 §3). */
    private readonly absoluteMaxSeconds: number,
  ) {}

  async create(userId: string): Promise<string> {
    const sessionId = randomBytes(32).toString("base64url");
    const now = Date.now();
    const record = {
      userId,
      createdAt: now,
      absoluteExpiry: now + this.absoluteMaxSeconds * 1000,
    };
    await this.kv.set(
      authSessionKey(sessionId),
      JSON.stringify(record),
      this.idleTtlSeconds,
    );
    await this.kv.sadd(authUserSessionsKey(userId), sessionId);
    return sessionId;
  }

  /**
   * Resolve a cookie's session id to its user, or null if unknown/expired.
   * Refreshes the idle TTL on the way through (sliding window), but never past
   * the absolute expiry.
   */
  async resolve(sessionId: string): Promise<ResolvedSession | null> {
    const raw = await this.kv.get(authSessionKey(sessionId));
    if (raw === null) return null;

    const record = SessionRecordSchema.parse(JSON.parse(raw));
    if (Date.now() > record.absoluteExpiry) {
      await this.destroy(sessionId);
      return null;
    }

    await this.kv.set(authSessionKey(sessionId), raw, this.idleTtlSeconds);
    return { sessionId, userId: record.userId };
  }

  /** Explicit logout — delete the one session (plan/21 §3). */
  async destroy(sessionId: string): Promise<void> {
    const raw = await this.kv.get(authSessionKey(sessionId));
    if (raw !== null) {
      const record = SessionRecordSchema.parse(JSON.parse(raw));
      await this.kv.srem(authUserSessionsKey(record.userId), sessionId);
    }
    await this.kv.del(authSessionKey(sessionId));
  }

  /** Revoke every session a user holds — the password-change hammer (§4, §7). */
  async destroyAllForUser(userId: string): Promise<void> {
    const ids = await this.kv.smembers(authUserSessionsKey(userId));
    for (const id of ids) {
      await this.kv.del(authSessionKey(id));
    }
    await this.kv.del(authUserSessionsKey(userId));
  }
}
