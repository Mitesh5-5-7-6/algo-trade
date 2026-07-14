import type { Db } from "mongodb";
import { UserSchema, type User } from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: number }).code === 11000
  );
}

/**
 * Users (plan/07 `users`, plan/21): operator accounts. Created via the
 * bootstrap CLI, never a self-service signup route (plan/07, plan/21 §6). The
 * unique `email` index guards against duplicates. Soft-disabled, never
 * hard-deleted, so audit links stay intact (plan/07 §3).
 */
export class UsersRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.users);
  }

  /** Insert a new user; false if the unique email index rejects it. */
  async create(user: User): Promise<boolean> {
    const doc = UserSchema.parse(user);
    try {
      await this.collection.insertOne({ ...doc });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  async findByEmail(email: string): Promise<User | null> {
    const doc = await this.collection.findOne(
      { email },
      { projection: { _id: 0 } },
    );
    return doc === null ? null : UserSchema.parse(doc);
  }

  async findById(userId: string): Promise<User | null> {
    const doc = await this.collection.findOne(
      { userId },
      { projection: { _id: 0 } },
    );
    return doc === null ? null : UserSchema.parse(doc);
  }

  /** Record a successful login (plan/21 §3 — login events are audit events). */
  async recordLogin(userId: string, at: number): Promise<void> {
    await this.collection.updateOne({ userId }, { $set: { lastLoginAt: at } });
  }

  async setPasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.collection.updateOne({ userId }, { $set: { passwordHash } });
  }

  /** How many operator accounts exist — the bootstrap CLI refuses a second. */
  async count(): Promise<number> {
    return this.collection.countDocuments();
  }
}
