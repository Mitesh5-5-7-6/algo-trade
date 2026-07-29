import { z, type ZodType } from "zod";
import type { ApiServer } from "../server.js";
import { ValidationError, UnauthorizedError } from "../errors.js";
import { BrokerTokensRepository } from "@neelkanth/db";
import { createHash } from "crypto";

export interface FyersAuthRoutesDeps {
  fyersAppId: string;
  fyersAppSecret: string;
  fyersRedirectUrl: string;
  brokerTokens: BrokerTokensRepository;
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
    throw new ValidationError("invalid request", { issues: result.error.issues });
  }
  return result.data;
}

export function registerFyersAuthRoutes(app: ApiServer, deps: FyersAuthRoutesDeps): void {
  // Returns the URL the dashboard should redirect the operator to for FYERS login
  app.get("/auth/fyers/login-url", async (_request, _reply) => {
    // Requires authenticated operator (auth guard handled externally)
    const url = `https://api.fyers.in/api/v3/generate-authcode?client_id=${deps.fyersAppId}&redirect_uri=${deps.fyersRedirectUrl}&response_type=code&state=fyers_auth`;
    return { url };
  });

  // The callback from FYERS — this is an OAuth redirect, so we check authUser
  app.get("/auth/fyers/callback", async (request, reply) => {
    const query = parse(CallbackQuery, request.query);

    if (query.code !== "200" || !query.auth_code) {
      throw new UnauthorizedError(`FYERS login failed: ${query.message ?? "No auth code"}`);
    }

    const appIdHash = createHash("sha256")
      .update(`${deps.fyersAppId}:${deps.fyersAppSecret}`)
      .digest("hex");

    const payload = {
      grant_type: "authorization_code",
      appIdHash,
      code: query.auth_code,
    };

    const response = await fetch("https://api.fyers.in/api/v3/validate-authcode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = (await response.json()) as FyersTokenResponse;
    if (!response.ok || data.s !== "ok") {
      throw new UnauthorizedError(`Failed to exchange token: ${data.message ?? "unknown"}`);
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

    // Redirect back to dashboard successfully
    reply.redirect("/");
  });
}
