import type { Db } from "mongodb";
import { OrderSchema, type Order, type OrderStatus } from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: number }).code === 11000
  );
}

/**
 * Orders (plan/07 `orders`): the execution audit stream, sole-written by the
 * Order Manager (plan/12 §7). The unique `signalId` index is the
 * duplicate-execution backstop — insert returns false rather than throwing so
 * the caller records the duplicate cleanly (plan/12 §6).
 */
export class OrdersRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.orders);
  }

  /** Insert a PLACED order; false when the unique signalId index rejects it. */
  async insert(order: Order): Promise<boolean> {
    const doc = OrderSchema.parse(order);
    try {
      await this.collection.insertOne({ ...doc });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  /** Patch an order toward a terminal state (plan/12 §5); validated fields only. */
  async update(orderId: string, patch: Partial<Order>): Promise<void> {
    const validated = OrderSchema.partial().parse(patch);
    await this.collection.updateOne({ orderId }, { $set: validated });
  }

  /** Orders in the given statuses — used to reconcile stuck orders on boot. */
  async findByStatus(statuses: readonly OrderStatus[]): Promise<Order[]> {
    const docs = await this.collection
      .find({ status: { $in: [...statuses] } }, { projection: { _id: 0 } })
      .toArray();
    return docs.map((doc) => OrderSchema.parse(doc));
  }

  async findByOrderId(orderId: string): Promise<Order | null> {
    const doc = await this.collection.findOne(
      { orderId },
      { projection: { _id: 0 } },
    );
    return doc === null ? null : OrderSchema.parse(doc);
  }

  /** Recent orders, newest first (dashboard order history). */
  async findRecent(limit: number): Promise<Order[]> {
    const docs = await this.collection
      .find({}, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map((doc) => OrderSchema.parse(doc));
  }
}
