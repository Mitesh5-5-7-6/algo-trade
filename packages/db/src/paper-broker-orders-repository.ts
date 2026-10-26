import type { Db } from "mongodb";
import { z } from "zod";
import {
  OrderSideSchema,
  OrderStatusSchema,
  OrderTypeSchema,
} from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

/**
 * One paper order as the paper broker recorded it (Phase 14 D3). Structurally
 * the broker's `PaperBookEntry`, so this repository is its `PaperBook`.
 */
export const PaperBrokerOrderDocSchema = z.object({
  clientOrderId: z.string().min(1),
  brokerOrderId: z.string().optional(),
  symbol: z.string().min(1),
  side: OrderSideSchema,
  qty: z.number().positive(),
  type: OrderTypeSchema,
  price: z.number().optional(),
  status: OrderStatusSchema,
  filledPrice: z.number().optional(),
  filledQty: z.number().optional(),
  slippage: z.number().optional(),
  charges: z.number().optional(),
  filledAt: z.number().optional(),
  reason: z.string().optional(),
  recordedAt: z.number().int().nonnegative(),
});
export type PaperBrokerOrderDoc = z.infer<typeof PaperBrokerOrderDocSchema>;

/** `paper_broker_orders` — the paper broker's book, in the paper database. */
export class PaperBrokerOrdersRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.paperBrokerOrders);
  }

  /** Write an entry, or merge into the one kept for its order (a cancel onto a pending). */
  async record(
    entry: Partial<PaperBrokerOrderDoc> &
      Pick<PaperBrokerOrderDoc, "clientOrderId" | "status" | "recordedAt">,
  ): Promise<void> {
    const fields = Object.fromEntries(
      Object.entries(entry).filter(([, v]) => v !== undefined),
    );
    await this.collection.updateOne(
      { clientOrderId: entry.clientOrderId },
      { $set: fields },
      { upsert: true },
    );
  }

  async find(clientOrderId: string): Promise<PaperBrokerOrderDoc | null> {
    const doc = await this.collection.findOne(
      { clientOrderId },
      { projection: { _id: 0 } },
    );
    return doc === null ? null : PaperBrokerOrderDocSchema.parse(doc);
  }

  /** Pending limit orders that still need market ticks or session expiry. */
  async findPending(symbol?: string): Promise<PaperBrokerOrderDoc[]> {
    const docs = await this.collection
      .find(
        {
          status: "PENDING",
          type: "LIMIT",
          ...(symbol === undefined ? {} : { symbol }),
        },
        { projection: { _id: 0 } },
      )
      .sort({ recordedAt: 1, clientOrderId: 1 })
      .toArray();
    return docs.map((doc) => PaperBrokerOrderDocSchema.parse(doc));
  }

  /** Every fill from `fromTs` on, oldest first — what reconciliation sums. */
  async filledSince(fromTs: number): Promise<PaperBrokerOrderDoc[]> {
    const docs = await this.collection
      .find(
        { status: "FILLED", filledAt: { $gte: fromTs } },
        { projection: { _id: 0 } },
      )
      .sort({ filledAt: 1, clientOrderId: 1 })
      .toArray();
    return docs.map((d) => PaperBrokerOrderDocSchema.parse(d));
  }

  /** Every recorded fill, for reconstructing the broker's current net position. */
  async allFills(): Promise<PaperBrokerOrderDoc[]> {
    const docs = await this.collection
      .find({ status: "FILLED" }, { projection: { _id: 0 } })
      .sort({ filledAt: 1, clientOrderId: 1 })
      .toArray();
    return docs.map((d) => PaperBrokerOrderDocSchema.parse(d));
  }

  /** Every book entry changed since the trading day's IST midnight. */
  async recordedSince(fromTs: number): Promise<PaperBrokerOrderDoc[]> {
    const docs = await this.collection
      .find({ recordedAt: { $gte: fromTs } }, { projection: { _id: 0 } })
      .sort({ recordedAt: 1, clientOrderId: 1 })
      .toArray();
    return docs.map((d) => PaperBrokerOrderDocSchema.parse(d));
  }
}
