# 21 — Authentication

> Prerequisites: **[05_BACKEND_ARCHITECTURE.md](05_BACKEND_ARCHITECTURE.md)** §4 (the control plane this protects), **[08_REDIS_ARCHITECTURE.md](08_REDIS_ARCHITECTURE.md)** §7 (session storage), **[10_WEBSOCKET_SYSTEM.md](10_WEBSOCKET_SYSTEM.md)** §7 (socket handshake).

---

## 1. Purpose

Authentication answers one question for every control-plane action: **is this the operator?** The stakes are unusual for an "auth chapter": whoever authenticates can enable strategies, change risk limits, reallocate capital, re-enable trading after a kill, and initiate the broker connection. Authentication here is not account hygiene — it is the lock on a machine that moves money.

---

## 2. The identity model — two identities, never conflated

Restating Chapter 19 §3's rule as this chapter's foundation:

1. **Operator → System.** The human proves identity to the platform (this chapter). Grants: the control plane (Chapter 05) and the live event stream (Chapter 10).
2. **System → Broker.** The platform proves identity to FYERS via tokens (`broker_tokens`, encrypted — Chapter 19 §3).

**Why the separation is load-bearing:** the dashboard and the operator's browser never see or handle broker credentials; compromising an operator session does not directly yield the broker tokens (they live server-side, encrypted, touched only inside the broker layer — Chapter 19 §8). The two credentials have different lifetimes, different rotation, different blast radii — coupling them would give any auth bug the maximum possible consequence.

---

## 3. Credentials & login

- **Password hashing: argon2id.** Memory-hard by design, so GPU/ASIC brute-forcing a leaked hash is expensive in the way that matters. (bcrypt is the acceptable fallback; plain/fast hashes are not an option — a leaked `users` collection must not become a leaked set of passwords.)
- **Login rate limiting + lockout** via the Redis limiter (`ratelimit:auth:*`, Chapter 08 §8): per-account and per-IP budgets, escalating lockout on repeated failure, every failure logged. **Why:** online brute force is the cheapest attack against a single-operator system; the limiter makes it slower than the credential is valuable.
- **Login events are audit events** — `lastLoginAt` on `users` (Chapter 07) plus a log entry; the operator of a money-moving system should be able to see when their account was used.

---

## 4. Sessions — and why sessions instead of JWTs

On successful login the server creates a random session id → `session:{id}` in Redis with a TTL (Chapter 08 §7) → delivered to the browser as an **httpOnly, Secure, SameSite cookie**.

**Why server-side sessions and not stateless JWTs — the decision, argued:** a JWT is valid until it expires, *no matter what*. For most apps that's a fine trade for statelessness. Here it's disqualifying: if the operator's device is compromised or a session leaks, the system must be able to **revoke access now** — not "within 15 minutes when the token expires," during which an attacker can raise risk limits and re-enable a killed system. Server-side sessions make revocation a single Redis delete: logout, lockout, and change-password-invalidates-everything are all immediate and absolute. The "cost" — a Redis lookup per request — is a sub-millisecond read on infrastructure we already run (Chapter 08 §2). Immediate revocability outranks statelessness for a control plane like this one.

**Why httpOnly cookies and not tokens in localStorage:** localStorage is readable by any script that achieves XSS; an httpOnly cookie is invisible to JavaScript entirely, removing the most common session-theft path. `SameSite` + CSRF protections cover the cookie's own attack class (Chapter 24).

**Session hygiene:** session id rotated on login (fixation defense); idle TTL refreshed on activity with an absolute maximum lifetime; explicit logout deletes server-side.

---

## 5. Where authentication is enforced

- **Every control-plane route.** A Fastify auth plugin (Chapter 05 §9) resolves the cookie → Redis session before any handler; no session, no handler. There are no unauthenticated mutating endpoints, and reads about money state are authenticated too.
- **The Socket.IO handshake** (Chapter 10 §7): the same session is validated at connect, and it gates **room membership** — authentication establishes who you are; authorization (which rooms) establishes what you may see. A revoked session also drops the live socket, so revocation cuts *both* channels at once.
- **Step-up confirmation for dangerous actions.** Re-enabling trading after a kill, changing capital allocation, and loosening global risk limits require explicit re-confirmation (password re-entry or a typed confirmation). **Why:** these are the actions where a hijacked-but-live session does maximum damage; a second gate converts "attacker has a cookie" into "attacker has a cookie *and* the credential."

---

## 6. Authorization

Today the system is **single-operator**: one authenticated identity, full control. The `users.role` field (Chapter 07) exists so a future viewer/operator split (read-only dashboards, admin-only kill re-enable) is a policy change, not a schema migration. Authorization decisions — like everything else consequential — are logged.

---

## 7. Failure modes

- **Redis down** → sessions unresolvable → control plane **fails closed**: no configuration changes possible. This is acceptable *because* the trading pipeline is simultaneously halting on the same Redis loss (Chapter 08 §11) — the operator locked out of a machine that is also safely stopped, never locked out of a machine still running.
- **Brute force** → limiter + lockout (§3); persistent attempts raise a notification (Chapter 07).
- **Session leak suspected** → revoke-all-sessions is one operation (delete `session:*` for the user); step-up gates (§5) bound the damage window meanwhile.
- **Operator forgets password** → recovery is deliberately manual/out-of-band for a single-operator system (server-side reset), because an automated email-reset flow is itself an attack surface that this system doesn't need to carry.

---

## 8. Roadmap

- **TOTP two-factor** on login and as the step-up mechanism — the single highest-value addition before live trading (Phase 3 gate, Chapter 28).
- **Session device listing** — show the operator their active sessions with one-click revocation.
- **Role-based access** activation when a second human ever touches the system.

---

*Previous: **[20_AI_ENGINE.md](20_AI_ENGINE.md)**  ·  Next: **[22_DEPLOYMENT.md](22_DEPLOYMENT.md)** — from developer PC to a running, supervised stack.*
