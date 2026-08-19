# Deploying `@neelkanth/api`

The environment for the **deployed** API. `/.env.example` at the repo root is
the development copy; this is the list you paste into Render / Railway / Fly /
a VPS unit file, with the values that differ once it is public.

Every name below is read either by the config schema
([`packages/config/src/index.ts`](../../packages/config/src/index.ts)) or
directly by a script. The process **refuses to boot** on a missing or invalid
required value and prints every problem at once — a half-configured money-mover
must never start (plan/04 §6).

---

## 1. Required — boot fails without these

| Variable | Constraint | Notes |
|---|---|---|
| `MONGO_URI` | must start with `mongodb` | `mongodb+srv://…` (Atlas) is fine. Must be reachable **from the host**, not just your laptop. |
| `REDIS_URL` | must start with `redis` | `rediss://…` for TLS also passes. |
| `SESSION_SECRET` | ≥ 32 chars | See the note in §6 — required, but nothing reads it yet. |
| `TOKEN_ENCRYPTION_KEY` | exactly 64 hex chars | AES-256-GCM key for broker tokens at rest (plan/24 §5). **Changing it makes every stored FYERS token undecryptable.** |

```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -hex 32      # TOKEN_ENCRYPTION_KEY  (must be exactly 64 hex chars)
```

## 2. Required in practice — the dashboard breaks without them

Defaults exist, but they are laptop defaults. Deployed, all three are wrong.

| Variable | Set to | Why |
|---|---|---|
| `NODE_ENV` | `production` | Turns on `Secure` on the session cookie. Left at the default `development`, the cookie is sent over plaintext HTTP. |
| `DASHBOARD_ORIGIN` | `https://algo-trade-dashboard-three.vercel.app` | The **one** origin allowed by CORS. Exactly one — `credentials: true` forbids a wildcard. Must match the browser's origin byte for byte: no trailing slash, no path. |
| `PUBLIC_API_ORIGIN` | this service's own public URL | Decides `SameSite` on the session cookie. See §5. |

## 3. Platform-injected — do not set by hand

| Variable | Who sets it |
|---|---|
| `PORT` | Render / Railway / Fly / Heroku |

When `PORT` is present, [`platform-env.ts`](src/platform-env.ts) maps it to
`API_PORT` and flips `API_HOST` to `0.0.0.0`. Without that the process binds
`127.0.0.1:4000`, looks healthy in its own logs, and the platform reports **"no
open ports detected"**. Set `API_HOST`/`API_PORT` explicitly only on a VPS where
you control the socket; they always win over `PORT`.

## 4. Broker — required only when `BROKER_MODE=live`

| Variable | Notes |
|---|---|
| `BROKER_MODE` | `paper` (default) or `live`. `live` executes **real orders**. |
| `FYERS_APP_ID` | From <https://myapi.fyers.in>. |
| `FYERS_APP_SECRET` | |
| `FYERS_REDIRECT_URL` | Must be `https://<this-api-host>/auth/fyers/callback` — validated at boot in live mode. |
| `FYERS_WEBHOOK_SECRET` | ≥ 16 chars, optional. Register the webhook as `…/webhooks/fyers?token=<secret>`. Empty reads as unset. |

`FYERS_REDIRECT_URL` has three hard requirements, all of them silent failures
if broken:

1. Path exactly `/auth/fyers/callback` — **no `/api` prefix**.
2. On **this API's** origin, not the dashboard's. The callback runs behind the
   auth guard and needs the session cookie, which only returns to the origin
   that set it.
3. Byte-identical to the URL registered at myapi.fyers.in.

## 5. `PUBLIC_API_ORIGIN` and the cookie trap

A browser sends a `SameSite=Lax` cookie only to the same **site** — the
registrable domain, not the origin. `app.example.com` and `api.example.com`
share the site `example.com`, so Lax works and CSRF protection is kept.

But hosts under a Public Suffix List entry do **not** share a site.
`a.vercel.app` and `b.vercel.app` are as unrelated to a browser as two
different companies — and `onrender.com`, `netlify.app`, `pages.dev`, `fly.dev`
and `github.io` behave the same way. A dashboard on Vercel with an API on
Render is therefore **cross-site**, and a Lax cookie is never sent: every
authenticated request 401s with nothing in the logs to explain it.

`PUBLIC_API_ORIGIN` is how [`same-site.ts`](src/auth/same-site.ts) works out
which case you are in. Cross-site ⇒ the cookie falls back to
`SameSite=None; Secure`, and the API logs a warning at boot, because that
forfeits the CSRF protection of plan/21 §3.

**Leaving it unset assumes cross-site.** That is the safe default: guessing
cross-site wrongly only costs CSRF hardening, while guessing same-site wrongly
silently breaks every request.

The real fix is a custom domain on both — `app.yourdomain.com` +
`api.yourdomain.com`. Then it is same-site, Lax works, and nothing is given up.

## 6. Optional

| Variable | Default | Notes |
|---|---|---|
| `LOG_LEVEL` | `info` | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` |
| `API_HOST` | `127.0.0.1` | Overridden to `0.0.0.0` when `PORT` is set. |
| `API_PORT` | `4000` | Overridden by `PORT` when set. |

**`SESSION_SECRET` is required but currently unused.** The config schema
enforces it and boot fails without it, but no code reads it: session ids come
from `SessionStore` backed by Redis, not from a derived signature. Set a real
random value anyway — when signing lands it will be load-bearing, and a
placeholder would quietly become a weak secret.

## 7. Operator bootstrap — the one-off script only

Read directly by [`bootstrap-operator.ts`](src/bootstrap-operator.ts), not by
the config schema. Needed once to create the first login, then removable.

| Variable | Notes |
|---|---|
| `NEELKANTH_OPERATOR_EMAIL` | |
| `NEELKANTH_OPERATOR_PASSWORD` | ≥ 12 chars |

On a deployed host the variables are already in the environment, so run the
compiled script directly:

```bash
node apps/api/dist/bootstrap-operator.js
```

The `pnpm --filter @neelkanth/api bootstrap:operator` shortcut is for local use
only — it passes `--env-file=../../.env`, which does not exist on the server.

---

## Render — filling in the New Web Service form

| Field | Value |
|---|---|
| **Name** | `algo-trade-api` |
| **Language** | `Node` |
| **Branch** | `main` |
| **Root Directory** | **leave empty** |
| **Build Command** | `pnpm install --frozen-lockfile && pnpm turbo run build --filter=@neelkanth/api...` |
| **Start Command** | `node apps/api/dist/main.js` |
| **Instance Type** | any **paid** tier — not Free |
| **Health Check Path** | `/health/live` |

### Root Directory must stay empty

This is a pnpm workspace: the lockfile, `pnpm-workspace.yaml` and every
`packages/*` dependency live at the repo root. Point Render at `apps/api` and
the install cannot resolve `@neelkanth/*` at all.

The side effect is intended — Render only auto-deploys on changes inside the
root directory, and a change to `packages/core` genuinely does change this
service.

### Build Command

The two things wrong with Render's default `pnpm install --frozen-lockfile; pnpm run build`:

- `;` runs the build even when the install failed, turning a clear dependency
  error into a confusing compile error. Use `&&`.
- Root `build` is `turbo run build`, which builds **everything** — including the
  Next.js dashboard that is deployed separately on Vercel. `--filter=@neelkanth/api...`
  builds the API and only the packages it depends on. (The trailing `...` is
  turbo syntax for "and its dependencies", not an ellipsis — type it literally.)

A clean build from scratch takes ~30s.

### Start Command

`node apps/api/dist/main.js` — the compiled entrypoint, run from the repo root.
Not `yarn start`: this repo uses pnpm, pinned by `packageManager: pnpm@10.15.1`
in the root `package.json`, which is also what tells Render to use pnpm at all.
Node 22 comes from `engines` and `.nvmrc`.

### Health Check Path

`/health/live`, **not** `/health/ready`. Liveness answers "restart me?";
readiness answers "trust me?". Pointing the platform at readiness makes it
restart-loop the service during a Redis blip — a restart cannot fix Redis
(plan/23 §4).

### Instance Type

**Not Free.** The free tier spins down after ~15 minutes idle. For a trading
system that is not a latency nit: the engines stop, and open positions go
unmanaged until a request happens to wake it — which, for an unattended
process, may be never.

### Region

Pick the region your MongoDB and Redis are already in — Render's private
network keeps those calls local, and every engine tick makes them.

Worth knowing: FYERS is in India, so Oregon adds roughly a quarter-second
round trip to order placement. Singapore is far closer. But moving *only* the
API there makes things worse — every database call would then cross the
Pacific instead. Treat it as all-or-nothing: keep the whole stack in Oregon, or
move the databases too.

## After deploying

1. Point the dashboard's `NEXT_PUBLIC_API_BASE` at this host **and redeploy
   it** — the dashboard is a static export, so that value is inlined at build
   time and changing the env var alone does nothing.
2. Retire the Vercel API deployment. Two control planes writing the same
   settings with no coordination is split-brain, and this is a money system.
3. Repoint the FYERS webhook to `https://<this-host>/webhooks/fyers`.

## Copy-paste skeleton

```dotenv
NODE_ENV=production
DASHBOARD_ORIGIN=https://algo-trade-dashboard-three.vercel.app
PUBLIC_API_ORIGIN=https://<your-service>.onrender.com

MONGO_URI=
REDIS_URL=
SESSION_SECRET=
TOKEN_ENCRYPTION_KEY=

BROKER_MODE=paper
FYERS_APP_ID=
FYERS_APP_SECRET=
FYERS_REDIRECT_URL=https://<your-service>.onrender.com/auth/fyers/callback
FYERS_WEBHOOK_SECRET=

LOG_LEVEL=info
```
