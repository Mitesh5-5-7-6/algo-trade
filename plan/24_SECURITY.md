# 24 — Security

> Prerequisites: **[21_AUTHENTICATION.md](21_AUTHENTICATION.md)** (the identity layer this builds on), **[19_BROKER_INTEGRATION.md](19_BROKER_INTEGRATION.md)** §3, §8 (the crown-jewel credentials), **[22_DEPLOYMENT.md](22_DEPLOYMENT.md)** §2, §5 (the perimeter and secrets placement).

---

## 1. Purpose — and the threat model first

Security work without a threat model is ritual. So, concretely, an attacker who compromises this system gains, in descending order of damage:

1. **The broker tokens** — the ability to place real trades with real money on the operator's account. The crown jewels.
2. **The control plane** — the ability to re-enable a killed system, raise risk limits, reallocate capital, and let the *machine itself* do the damage "legitimately."
3. **The audit trail** — the ability to alter or erase the record of what happened.
4. **The data** — positions, PnL, strategy configs: the operator's private financial activity.

Every control in this chapter exists to protect one of these four. The design stance throughout is **defense in depth**: no single control is trusted to hold alone, and the final backstop — the kill switch and fail-closed behaviors woven through this book — bounds the damage even when controls fail.

---

## 2. Layer 1 — Network perimeter

- **One ingress.** Only the reverse proxy is exposed (Chapter 22 §2); `api`, `redis`, `mongo`, and `dashboard` static hosting live on the internal Docker network with **no published ports**. **Why:** an unexposed Redis/Mongo cannot be attacked from the internet at all — the strongest control is absence of surface. (Internet-exposed default-config Mongo/Redis instances are among the most-compromised services that exist; this system simply never joins that population.)
- **Host firewall** allows 80/443 (proxy) and SSH only. SSH: **key-only, no password auth, no root login.**
- **CI is outside the perimeter by design** — it holds no production secrets and no route to production data (Chapter 22 §5); a compromised CI can poison a build (mitigated in §6) but cannot read tokens or the database.

---

## 3. Layer 2 — Transport

- **TLS everywhere external:** the proxy terminates HTTPS for both the dashboard and the api; HTTP redirects; HSTS set. **Why non-negotiable:** the session cookie (Chapter 21 §4) and every control-plane action transit here — plaintext transport would hand an on-path attacker the operator's session, i.e., item 2 of the threat model.
- The Socket.IO channel rides the same TLS origin (Chapter 10) — live positions and PnL are as sensitive in motion as at rest.
- **Internal traffic** (api ↔ redis/mongo) stays on the isolated Docker network — unreachable rather than encrypted-but-reachable.

---

## 4. Layer 3 — Application

- **Validation at every boundary** — Zod on all input before any logic (Chapter 05 §4). This is simultaneously a correctness rule and the first injection defense: input that doesn't match the declared shape never reaches a query or a service.
- **NoSQL injection** — repositories build queries from typed, validated values only; user input is never interpolated into query *operators* (the classic Mongo `$where`/`$gt`-smuggling class dies at the Zod boundary, since object-shaped "strings" fail parsing).
- **XSS** — the session cookie is httpOnly (invisible to any injected script — Chapter 21 §4); React's default output encoding is relied on (no `dangerouslySetInnerHTML` on user- or news-derived content — note news items are external input); the proxy sets a restrictive **Content-Security-Policy**. **Why XSS gets this attention:** in this app, script execution in the operator's browser *is* control-plane access.
- **CSRF** — `SameSite` cookies plus origin checks on mutating routes. The step-up confirmations on dangerous actions (Chapter 21 §5) are also the last-line CSRF/hijack backstop: even a riding request can't re-enable a killed system without the credential.
- **Rate limiting** on auth and on the API generally (Chapter 08 §8) — brute force and abuse throttled at the shared limiter.
- **Prompt injection** (the AI-era input class) — already contained architecturally: hostile news content can at worst nudge a clamped number that still faces the Risk Engine (Chapter 20 §6). Referenced here so the threat model is complete in one place.

---

## 5. Layer 4 — Data & secrets

- **Broker tokens: encrypted at rest, AES-256-GCM**, key supplied via environment (Chapter 22 §5), decrypted only inside the broker layer, **never logged** (redaction enforced in logger config — Chapter 23 §3), never sent to any client (Chapter 19 §8, Chapter 21 §2). **Why encryption at rest specifically:** the realistic leak path for the database is a stolen *backup* (Chapter 22 §6 ships dumps off-box); encrypted tokens make a leaked dump a data breach but not a *trading-access* breach — it decouples threat-model item 4 from item 1.
- **Key separation:** the token-encryption key lives only on the VPS environment — deliberately *not* alongside the off-box backups, so no single stolen artifact yields usable credentials.
- **Passwords:** argon2id (Chapter 21 §3). **Sessions:** httpOnly cookies, Redis-side revocable (Chapter 21 §4).
- **No secrets in the repository, ever** — env-supplied per Chapter 22 §5; the repo history is treated as public even though it isn't.
- **Audit immutability:** append-only collections with terminal-state immutability (Chapter 07 §3, Chapter 12 §5) mean tampering requires database-level access *and* leaves reconcile divergence (Chapter 13 §6) — protecting threat-model item 3 with detection layered on prevention.

---

## 6. Layer 5 — Supply chain & code

- **Lockfile-pinned dependencies** (pnpm — which also structurally prevents phantom imports, Chapter 03 §3); dependency updates are deliberate, reviewed changes, not drift.
- **`audit` in CI** — known-vulnerable versions block the pipeline like any other red check (Chapter 22 §2).
- **Immutable, SHA-tagged images** (Chapter 22 §2): what was tested is what runs, and what runs is traceable to a commit — a poisoned artifact can't silently substitute for a reviewed one.
- **Containers run as non-root**, minimizing what a compromised process can do to its host.

---

## 7. The security properties the *architecture* already provides

Worth stating because they're easy to take for granted — several of this system's strongest controls are structural, not bolted on:

- **The kill switch bounds every scenario** — whatever is going wrong, one persisted flag stops all execution (Chapters 07, 12 §4), and a restart doesn't un-stop it.
- **Fail-closed defaults** — risk unverifiable ⇒ block (Chapter 14 §9); Redis down ⇒ halt orders (Chapter 08 §11); config invalid ⇒ don't boot (Chapter 04 §6). An attacker degrading infrastructure degrades the system *into* safety, not out of it.
- **Single choke point** — there is exactly one code path to a broker (Chapter 02 §11), so "could anything place an order around the controls?" has a checkable answer: no.
- **Two-identity separation** — operator compromise ≠ broker-credential compromise (Chapter 21 §2).

---

## 8. Failure modes & incident posture

- **Suspected session/control-plane compromise** → kill switch → revoke all sessions (Chapter 21 §7) → rotate credentials → inspect `risk_logs`/`orders`/access logs (the audit trail is the incident record) → resume only after step-up re-auth.
- **Suspected token leak** → invalidate at FYERS (the broker-side revocation is authoritative) → rotate encryption key → re-auth flow (Chapter 19 §3).
- **VPS compromise** → the Chapter 22 §7 rebuild path *is* the incident response: fresh provision, restore from off-box backup, rotate every secret, redeploy from a known SHA.
- The standing rule from the threat model: **when in doubt, halt first.** A stopped trading system loses opportunity; a compromised running one loses money.

---

## 9. Roadmap

- **TOTP 2FA** — the top pre-live item (Chapter 21 §8, Chapter 28 gate).
- **Secrets manager** (Vault/SOPS-style) replacing the env file as secret count grows.
- **Fail2ban / SSH intrusion throttling** and automated OS patching on the VPS.
- **Dependency-update automation** with review gates (Renovate-style), keeping §6 current without drift.

---

*Previous: **[23_MONITORING.md](23_MONITORING.md)**  ·  Next: **[25_CODING_STANDARDS.md](25_CODING_STANDARDS.md)** — the conventions that keep contributors coherent.*
