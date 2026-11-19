import { createHash } from "node:crypto";

/**
 * FYERS access tokens "expire daily at 6:30 AM" (FYERS API v3 docs,
 * individual-app authentication, read 2026-11-19). This is the next 06:30 IST
 * strictly after `issuedAt` — the expiry a token stored at `issuedAt` really
 * has, where the system used to assume fourteen hours.
 */
export function fyersTokenExpiry(issuedAt: number): number {
  const IST = 19_800_000;
  const DAY = 86_400_000;
  const SIX_THIRTY = (6 * 60 + 30) * 60_000;
  const istMidnight = Math.floor((issuedAt + IST) / DAY) * DAY - IST;
  const today = istMidnight + SIX_THIRTY;
  return issuedAt < today ? today : today + DAY;
}

export type RenewalResult =
  | { ok: true; accessToken: string; refreshToken?: string }
  | { ok: false; reason: string };

export interface RenewalRequest {
  appId: string;
  appSecret: string;
  /** The refresh token FYERS returned with the last interactive login. */
  refreshToken: string;
  /** The account PIN — FYERS requires it on every refresh. */
  pin: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/**
 * A new access token from the stored refresh token and the PIN (operator
 * decision 2026-11-19: automatic morning login, the reminder as its backup).
 *
 * **Not in FYERS's published v3 documentation**, nor in its own SDK. The call
 * — `POST /api/v3/validate-refresh-token` with `grant_type`, `appIdHash`,
 * `refresh_token` and `pin` — is the one used on FYERS's community forum,
 * where no success has been reported since its v2 predecessor was retired
 * in April 2025. So it is an attempt, never a dependency: it never throws,
 * and every refusal comes back with FYERS's own words for the reminder to
 * carry.
 */
export async function renewWithRefreshToken(
  request: RenewalRequest,
): Promise<RenewalResult> {
  const send = request.fetch ?? globalThis.fetch;
  const appIdHash = createHash("sha256")
    .update(`${request.appId}:${request.appSecret}`)
    .digest("hex");
  let response: Response;
  try {
    response = await send(
      "https://api-t1.fyers.in/api/v3/validate-refresh-token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          appIdHash,
          refresh_token: request.refreshToken,
          pin: request.pin,
        }),
        signal: AbortSignal.timeout(request.timeoutMs ?? 15_000),
      },
    );
  } catch (error) {
    return {
      ok: false,
      reason: `FYERS did not answer: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let body: {
    s?: string;
    code?: number;
    message?: string;
    access_token?: string;
    refresh_token?: string;
  } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return {
      ok: false,
      reason: `FYERS answered HTTP ${String(response.status)} with no readable body`,
    };
  }
  if (!response.ok || body.s !== "ok" || !body.access_token)
    return {
      ok: false,
      reason: `FYERS refused the refresh (HTTP ${String(response.status)}${body.code === undefined ? "" : `, code ${String(body.code)}`}): ${body.message ?? "no message"}`,
    };
  return {
    ok: true,
    accessToken: body.access_token,
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
  };
}
