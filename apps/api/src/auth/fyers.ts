import { z, type ZodType } from "zod";
import type { ApiServer } from "../server.js";
import { ValidationError, UnauthorizedError } from "../errors.js";
import { BrokerTokensRepository } from "@neelkanth/db";
import { createHash } from "crypto";

export interface FyersAuthRoutesDeps {
  fyersAppId: string;
  fyersAppSecret: string;
  /**
   * Must be an absolute URL on THIS origin, path `/auth/fyers/callback`, and
   * byte-identical to what is registered at myapi.fyers.in — FYERS matches it
   * exactly. It has to be this origin because the callback runs behind the
   * auth guard: the session cookie is `SameSite=Lax`, so it rides along on
   * the broker's top-level GET redirect, but only back to the origin that set
   * it. A callback pointed at the dashboard arrives with no session.
   */
  fyersRedirectUrl: string;
  /** Where the operator's browser is sent once the token is stored. */
  dashboardOrigin: string;
  brokerTokens: BrokerTokensRepository;
  /**
   * Called after a fresh token lands, so the market-data feed can be brought
   * back up. Without it, reconnecting stores a valid token and changes
   * nothing: broker.connect() only runs at boot, so the feed stays down until
   * the process restarts — and the whole point of the button is to avoid that.
   */
  onTokenStored?: () => Promise<void>;
}

const CallbackQuery = z.object({
  auth_code: z.string().min(1).optional(),
  state: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});

/** Loose shape for the FYERS validate-authcode response. */
interface FyersTokenResponse {
  s: string;
  message?: string;
  access_token?: string;
  refresh_token?: string;
}

function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError("invalid request", {
      issues: result.error.issues,
    });
  }
  return result.data;
}

export function registerFyersAuthRoutes(
  app: ApiServer,
  deps: FyersAuthRoutesDeps,
): void {
  // Returns the URL the dashboard should redirect the operator to for FYERS login
  app.get("/auth/fyers/login-url", () => {
    // Requires authenticated operator (auth guard handled externally).
    // Every value is percent-encoded: the redirect URL carries `://` and `/`,
    // and an unencoded query parameter is what makes FYERS reject the
    // redirect as not matching the one registered on the app.
    const params = new URLSearchParams({
      client_id: deps.fyersAppId,
      redirect_uri: deps.fyersRedirectUrl,
      response_type: "code",
      state: "fyers_auth",
    });
    return {
      url: `https://api-t1.fyers.in/api/v3/generate-authcode?${params.toString()}`,
    };
  });

  // The callback from FYERS — this is an OAuth redirect, so we check authUser
  app.get("/auth/fyers/callback", async (request, reply) => {
    const query = parse(CallbackQuery, request.query);

    if (query.code !== "200" || !query.auth_code) {
      throw new UnauthorizedError(
        `FYERS login failed: ${query.message ?? "No auth code"}`,
      );
    }

    const appIdHash = createHash("sha256")
      .update(`${deps.fyersAppId}:${deps.fyersAppSecret}`)
      .digest("hex");

    const payload = {
      grant_type: "authorization_code",
      appIdHash,
      code: query.auth_code,
    };

    const response = await fetch(
      "https://api-t1.fyers.in/api/v3/validate-authcode",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );

    const data = (await response.json()) as FyersTokenResponse;
    if (!response.ok || data.s !== "ok") {
      throw new UnauthorizedError(
        `Failed to exchange token: ${data.message ?? "unknown"}`,
      );
    }

    // FYERS access tokens usually expire daily (~14 hours).
    const expiresAt = Date.now() + 14 * 60 * 60 * 1000;

    // The request must carry a valid session (authUser set by the guard).
    const userId = request.authUser?.userId;
    if (!userId) {
      throw new UnauthorizedError("Operator session missing during callback");
    }

    await deps.brokerTokens.saveToken(
      userId,
      data.access_token ?? "",
      expiresAt,
      data.refresh_token,
    );

    // Bring the feed up with the new token before redirecting, so the
    // dashboard renders the result of this action rather than a stale
    // NO FEED the operator would have to refresh past. A failure here is not
    // the login's failure — the token IS stored — so it must not turn a
    // successful auth into an error page.
    if (deps.onTokenStored) {
      try {
        await deps.onTokenStored();
      } catch (error) {
        request.log.error({ err: error }, "broker reconnect after token store failed");
      }
    }

    // Back to the dashboard — an absolute URL, because we are on the API
    // origin here, not the dashboard's. `reply.redirect("/")` would land the
    // operator on the API root, which serves nothing.
    reply.redirect(deps.dashboardOrigin);
  });
}
