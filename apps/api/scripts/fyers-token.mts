/**
 * One-shot FYERS access-token helper (Phase 1, task 1.8).
 *
 * Exists so a token can be obtained without pasting one into a chat window or
 * a shell history. The exchange needs the app SECRET, which must never leave
 * this machine, so this runs locally and writes the result straight into
 * `.env.local` — the token is never printed in full and never travels through
 * anything that keeps a transcript.
 *
 * It is not part of the app. The real login flow lives in
 * `apps/api/src/auth/fyers.ts` and stores the token in Mongo for the running
 * engine; this is the operator-side equivalent for a scratch environment where
 * the deployed database is deliberately out of reach. Every vendor detail here
 * — the authcode URL, the `appIdHash` construction, the validate payload — is
 * copied from that file rather than derived, so the two cannot drift.
 *
 * Step 1 — print the login URL:
 *
 *   cd apps/api
 *   node --env-file=../../.env.local scripts/fyers-token.mts
 *
 * Log in. The browser lands on the redirect URL. If nothing is listening on
 * that port the page fails to load — that is fine and expected; the value is
 * in the address bar.
 *
 * Step 2 — exchange the code (it is single-use and expires within minutes):
 *
 *   node --env-file=../../.env.local scripts/fyers-token.mts --code=<auth_code>
 *
 * The token is written to `.env.local` as FYERS_ACCESS_TOKEN and verified with
 * one read-only call. FYERS access tokens expire in roughly 14 hours, so this
 * is worth doing immediately before a probe or a backfill, not in advance.
 *
 * Delete this script once Phase 1's ingestion is proven, alongside the probe.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ENV_PATH = path.resolve(process.cwd(), "../../.env.local");
const TOKEN_KEY = "FYERS_ACCESS_TOKEN";

const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? "true"] as const;
    }),
);

interface FyersTokenResponse {
  s?: string;
  message?: string;
  access_token?: string;
  refresh_token?: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is not set (use --env-file=../../.env.local)`);
  return value;
}

/** Enough to confirm which token is in place, not enough to use. */
const fingerprint = (token: string): string =>
  `${token.slice(0, 6)}…${token.slice(-4)} (${String(token.length)} chars)`;

function loginUrl(appId: string, redirectUrl: string): string {
  // Every value percent-encoded: the redirect carries `://` and `/`, and an
  // unencoded parameter is what makes FYERS reject it as not matching the
  // redirect registered on the app.
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUrl,
    response_type: "code",
    state: "fyers_auth",
  });
  return `https://api-t1.fyers.in/api/v3/generate-authcode?${params.toString()}`;
}

async function exchange(
  appId: string,
  appSecret: string,
  code: string,
): Promise<string> {
  const appIdHash = createHash("sha256")
    .update(`${appId}:${appSecret}`)
    .digest("hex");

  const response = await fetch(
    "https://api-t1.fyers.in/api/v3/validate-authcode",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        appIdHash,
        code,
      }),
    },
  );

  const data = (await response.json()) as FyersTokenResponse;
  if (!response.ok || data.s !== "ok" || !data.access_token) {
    throw new Error(
      `exchange failed (HTTP ${String(response.status)}): ${data.message ?? "unknown"}. ` +
        "An auth code is single-use and expires within minutes — if this is a " +
        "retry, get a fresh one from the login URL.",
    );
  }
  return data.access_token;
}

/**
 * Replace or append one key, leaving every other line byte-identical.
 *
 * This file holds live credentials, so it is rewritten rather than
 * regenerated: a helper that reformatted it could lose a value that exists
 * nowhere else.
 */
function writeToken(token: string): void {
  if (!fs.existsSync(ENV_PATH))
    throw new Error(`${ENV_PATH} does not exist — create it first`);

  const original = fs.readFileSync(ENV_PATH, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const line = `${TOKEN_KEY}="${token}"`;

  const index = lines.findIndex((l) => l.startsWith(`${TOKEN_KEY}=`));
  if (index === -1) {
    // Keep a trailing blank line if the file had one.
    const at = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    lines.splice(at, 0, line);
  } else {
    lines[index] = line;
  }

  fs.writeFileSync(ENV_PATH, lines.join(eol));
}

/** One read-only call, so a bad token is discovered now and not mid-backfill. */
async function verify(appId: string, token: string): Promise<void> {
  const url = `https://api-t1.fyers.in/data/history?${new URLSearchParams({
    symbol: "NSE:NIFTY50-INDEX",
    resolution: "5",
    date_format: "1",
    range_from: "2026-09-25",
    range_to: "2026-09-25",
    cont_flag: "1",
  }).toString()}`;

  const response = await fetch(url, {
    headers: { Authorization: `${appId}:${token}`, version: "3" },
  });
  const body = (await response.json()) as { s?: string; message?: string };

  if (response.status === 401 || body.s === "error")
    throw new Error(
      `the token was issued but rejected by the data API: ${body.message ?? "unknown"}`,
    );
  console.log(
    `verified against the history API (HTTP ${String(response.status)}, s=${body.s ?? "?"})`,
  );
}

async function main(): Promise<void> {
  const appId = required("FYERS_APP_ID");
  const code = args.get("code");

  if (code === undefined || code === "true") {
    const redirectUrl = required("FYERS_REDIRECT_URL");
    console.log("1. Open this and log in:\n");
    console.log(`   ${loginUrl(appId, redirectUrl)}\n`);
    console.log(
      `2. You will be redirected to ${redirectUrl}. If nothing is listening\n` +
        "   there the page will fail to load — that is expected. Copy the\n" +
        "   auth_code value out of the address bar.\n",
    );
    console.log("3. Then run:\n");
    console.log(
      "   node --env-file=../../.env.local scripts/fyers-token.mts --code=<auth_code>\n",
    );
    return;
  }

  const appSecret = required("FYERS_APP_SECRET");
  const token = await exchange(appId, appSecret, code);
  writeToken(token);
  console.log(`wrote ${TOKEN_KEY} to .env.local — ${fingerprint(token)}`);
  await verify(appId, token);
  console.log(
    "\nExpires in roughly 14 hours. Next:\n" +
      "  node --env-file=../../.env.local scripts/probe-fyers-history.mts",
  );
}

main().catch((error: unknown) => {
  console.error(`\nfyers-token failed: ${(error as Error).message}`);
  // Not process.exit(): on Windows it can tear down an in-flight fetch
  // handle mid-close and print a libuv assertion after the real error,
  // which reads like a second, worse failure.
  process.exitCode = 1;
});
