import crypto from "node:crypto";

/**
 * Pure Node.js TOTP implementation (RFC 6238) — zero external deps.
 * Uses the standard approach with 0 charge (plan/21 §8).
 *
 * Compatible with Google Authenticator, Authy, 1Password, etc.
 */

// --- Base32 encode/decode (RFC 4648) ---

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
  }
  return output;
}

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

// --- TOTP core (RFC 6238) ---

function generateHOTP(secret: Buffer, counter: bigint): string {
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

function currentCounter(stepSeconds = 30): bigint {
  return BigInt(Math.floor(Date.now() / 1000 / stepSeconds));
}

// --- Public API ---

/** Generate a random 20-byte TOTP secret, returned as base32. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** Build a standard `otpauth://` URI for QR code scanning. */
export function generateTotpUrl(email: string, secret: string): string {
  const issuer = encodeURIComponent("Neelkanth");
  const label = encodeURIComponent(`Neelkanth:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

/**
 * Verify a 6-digit token against the secret.
 * Allows ±1 time step window to account for clock drift.
 */
export function verifyTotpToken(token: string, secret: string): boolean {
  const secretBuffer = base32Decode(secret);
  const counter = currentCounter();

  // Check current, previous, and next time step (±30s window)
  for (let i = -1; i <= 1; i++) {
    const expected = generateHOTP(secretBuffer, counter + BigInt(i));
    if (crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      return true;
    }
  }
  return false;
}
