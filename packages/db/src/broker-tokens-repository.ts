import type { Db } from "mongodb";
import { BrokerTokenSchema, type BrokerToken } from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

/**
 * Broker Tokens (plan/07 `broker_tokens`, plan/19 §3).
 * Stores encrypted broker credentials. The repository relies on the caller
 * to encrypt the payload before saving it. We use AES-256-GCM encryption.
 * Wait, actually we can do encryption IN the repository to ensure it's never
 * missed. Let's do that for safety.
 */
import * as crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function encrypt(text: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) throw new Error("Invalid encryption key length");
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

function decrypt(cipherTextBase64: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) throw new Error("Invalid encryption key length");
  const data = Buffer.from(cipherTextBase64, "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

export class BrokerTokensRepository {
  private readonly collection;
  private readonly keyHex: string;

  /**
   * @param db - The connected MongoDB instance
   * @param encryptionKeyHex - 32 bytes hex key (from config.TOKEN_ENCRYPTION_KEY)
   */
  constructor(db: Db, encryptionKeyHex: string) {
    this.collection = db.collection(COLLECTIONS.brokerTokens);
    this.keyHex = encryptionKeyHex;
  }

  /** Upsert the broker token for the operator. Assumes 1 operator per userId. */
  async saveToken(
    userId: string,
    rawAccessToken: string,
    expiresAt: number,
    rawRefreshToken?: string,
  ): Promise<void> {
    const encryptedToken = encrypt(rawAccessToken, this.keyHex);
    const encryptedRefreshToken = rawRefreshToken
      ? encrypt(rawRefreshToken, this.keyHex)
      : undefined;

    const doc: BrokerToken = {
      userId,
      encryptedToken,
      encryptedRefreshToken,
      expiresAt,
      updatedAt: Date.now(),
    };

    const valid = BrokerTokenSchema.parse(doc);

    await this.collection.updateOne(
      { userId },
      { $set: valid },
      { upsert: true },
    );
  }

  /**
   * Retrieves and decrypts the broker token for a user.
   * Returns null if not found.
   */
  async getDecryptedToken(userId: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
  } | null> {
    const doc = await this.collection.findOne(
      { userId },
      { projection: { _id: 0 } },
    );
    if (!doc) return null;

    const tokenDoc = BrokerTokenSchema.parse(doc);
    const accessToken = decrypt(tokenDoc.encryptedToken, this.keyHex);
    const refreshToken = tokenDoc.encryptedRefreshToken
      ? decrypt(tokenDoc.encryptedRefreshToken, this.keyHex)
      : undefined;

    const result: {
      accessToken: string;
      refreshToken?: string;
      expiresAt: number;
    } = {
      accessToken,
      expiresAt: tokenDoc.expiresAt,
    };
    if (refreshToken !== undefined) {
      result.refreshToken = refreshToken;
    }
    return result;
  }

  async deleteToken(userId: string): Promise<void> {
    await this.collection.deleteOne({ userId });
  }
}
