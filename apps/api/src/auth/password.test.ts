import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password hashing (plan/21 §3)", () => {
  it("produces an argon2id hash that verifies", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(
      true,
    );
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("s3cret");
    expect(await verifyPassword(hash, "not-it")).toBe(false);
  });

  it("salts — the same password hashes differently each time", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
  });

  it("treats a malformed stored hash as a non-match, not a throw", async () => {
    expect(await verifyPassword("not-a-real-hash", "anything")).toBe(false);
  });
});
