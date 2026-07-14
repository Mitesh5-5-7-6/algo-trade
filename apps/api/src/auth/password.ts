import { hash, verify } from "@node-rs/argon2";

/**
 * Password hashing with **argon2id** (plan/21 §3): memory-hard by design, so
 * GPU/ASIC brute-forcing a leaked hash is expensive in the way that matters. A
 * leaked `users` collection must never become a leaked set of passwords.
 *
 * argon2id is @node-rs/argon2's default algorithm (its `Algorithm` enum is an
 * ambient const enum we can't reference under verbatimModuleSyntax), so we tune
 * only the cost parameters and let the default pick the variant.
 */
const OPTIONS = {
  memoryCost: 19_456, // 19 MiB — OWASP-recommended floor
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

/** Verify; a malformed stored hash is a non-match, never a throw. */
export async function verifyPassword(
  passwordHash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}
