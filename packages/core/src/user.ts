import { z } from "zod";
import { EntityIdSchema, TimestampSchema } from "./primitives.js";

/**
 * Operator accounts (plan/07 `users`, plan/21). The system is single-operator
 * today; the `role` field exists so a future viewer/operator split is a policy
 * change, not a migration (plan/21 §6). The password is stored ONLY as an
 * argon2id hash (plan/21 §3) — never the plaintext.
 */
export const UserRoleSchema = z.enum(["operator", "viewer"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const UserStatusSchema = z.enum(["active", "disabled"]);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const UserSchema = z.object({
  userId: EntityIdSchema,
  email: z.string().email(),
  /** argon2id hash (plan/21 §3); never the plaintext, never logged (plan/23 §3). */
  passwordHash: z.string().min(1),
  role: UserRoleSchema,
  status: UserStatusSchema,
  createdAt: TimestampSchema,
  lastLoginAt: TimestampSchema.optional(),
});
export type User = z.infer<typeof UserSchema>;
