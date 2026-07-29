import crypto from "node:crypto";

/**
 * Test-only helper: generates a valid TOTP token for a given base32 secret.
 * Uses the exact same algorithm as totp.ts so tests can verify the full flow.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function generateTestToken(base32Secret: string): string {
  const secret = base32Decode(base32Secret);
  const counter = BigInt(Math.floor(Date.now() / 1000 / 30));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);

  const hmac = crypto.createHmac("sha1", secret);
  hmac.update(counterBuffer);
  const hash = hmac.digest();

  const offset = (hash[hash.length - 1] as number) & 0x0f;
  const code =
    (((hash[offset] as number) & 0x7f) << 24) |
    (((hash[offset + 1] as number) & 0xff) << 16) |
    (((hash[offset + 2] as number) & 0xff) << 8) |
    ((hash[offset + 3] as number) & 0xff);

  return String(code % 1_000_000).padStart(6, "0");
}
