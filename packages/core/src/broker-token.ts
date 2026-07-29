import { z } from "zod";
import { EntityIdSchema, TimestampSchema } from "./primitives.js";

/**
 * Broker token (plan/07 `broker_tokens`, plan/19 §3). 
 * Stores the access token needed to authenticate with the live broker (FYERS).
 * The token string MUST be encrypted at rest and is decrypted only when needed
 * by the Broker adapter.
 */
export const BrokerTokenSchema = z.object({
  /** The user ID this token belongs to (the operator). */
  userId: EntityIdSchema,
  /** The encrypted token payload (e.g. FYERS access token), hex or base64. */
  encryptedToken: z.string().min(1),
  /** The FYERS refresh token (also encrypted), if applicable. */
  encryptedRefreshToken: z.string().optional(),
  /** When this token expires (used by token-refresh job to act before expiry). */
  expiresAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type BrokerToken = z.infer<typeof BrokerTokenSchema>;
