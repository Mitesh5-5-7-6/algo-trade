import { randomUUID } from "node:crypto";
import type { User, UserRole } from "@neelkanth/core";
import type { UsersRepository } from "@neelkanth/db";
import { hashPassword } from "./password.js";

export interface CreateOperatorInput {
  email: string;
  password: string;
  role?: UserRole;
}

export type CreateOperatorResult =
  { created: true; userId: string } | { created: false; reason: string };

/**
 * Create the operator account (plan/21 §6) — the ONLY way an account comes into
 * being. There is no signup route; provisioning is an out-of-band, server-side
 * act. This refuses to create a second account while one exists (single-
 * operator system) and stores only the argon2id hash, never the plaintext.
 */
export async function createOperator(
  users: UsersRepository,
  input: CreateOperatorInput,
): Promise<CreateOperatorResult> {
  if ((await users.count()) > 0) {
    return { created: false, reason: "an operator account already exists" };
  }
  const user: User = {
    userId: `usr_${randomUUID()}`,
    email: input.email.toLowerCase(),
    passwordHash: await hashPassword(input.password),
    role: input.role ?? "operator",
    status: "active",
    createdAt: Date.now(),
  };
  const inserted = await users.create(user);
  return inserted
    ? { created: true, userId: user.userId }
    : { created: false, reason: "email already registered" };
}
