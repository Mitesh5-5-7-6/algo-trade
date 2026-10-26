import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "./test-support/infra.js";
import {
  COLLECTIONS,
  ensureIndexes,
  PaperBrokerOrdersRepository,
  type MongoConnection,
} from "./index.js";

const MONGO_URI =
  process.env["MONGO_URI"] ??
  "mongodb://localhost:27017/neelkanth_paper_broker_orders_test";

let probe: MongoProbe | undefined;
let connection: MongoConnection;

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_paper_broker_orders",
    "packages/db/src/paper-broker-orders-repository.integration.test.ts",
  );
  if (!probe.reachable) return;
  connection = probe.connection;
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);
});

beforeEach(async (ctx) => {
  if (probe?.reachable !== true) {
    ctx.skip();
    return;
  }
  await connection.db.collection(COLLECTIONS.paperBrokerOrders).deleteMany({});
});

afterAll(async () => {
  await closeProbe(probe);
});

describe("PaperBrokerOrdersRepository — persistent broker book", () => {
  it("keeps a filled order and its full fill across repository instances", async () => {
    const first = new PaperBrokerOrdersRepository(connection.db);
    await first.record({
      clientOrderId: "ord_restart",
      symbol: "NSE:RELIANCE-EQ",
      side: "BUY",
      qty: 10,
      type: "MARKET",
      status: "PENDING",
      brokerOrderId: "paper-1",
      recordedAt: 1_700_000_000_000,
    });
    await first.record({
      clientOrderId: "ord_restart",
      status: "FILLED",
      filledPrice: 100.1,
      filledQty: 10,
      slippage: 0.1,
      charges: 2,
      filledAt: 1_700_000_000_100,
      recordedAt: 1_700_000_000_100,
    });

    const restarted = new PaperBrokerOrdersRepository(connection.db);
    expect(await restarted.find("ord_restart")).toEqual({
      clientOrderId: "ord_restart",
      brokerOrderId: "paper-1",
      symbol: "NSE:RELIANCE-EQ",
      side: "BUY",
      qty: 10,
      type: "MARKET",
      status: "FILLED",
      filledPrice: 100.1,
      filledQty: 10,
      slippage: 0.1,
      charges: 2,
      filledAt: 1_700_000_000_100,
      recordedAt: 1_700_000_000_100,
    });
    expect(
      (await restarted.allFills()).map((order) => order.clientOrderId),
    ).toEqual(["ord_restart"]);
    expect(
      (await restarted.recordedSince(1_700_000_000_100)).map(
        (order) => order.clientOrderId,
      ),
    ).toEqual(["ord_restart"]);
  });

  it("returns fills from an inclusive timestamp in deterministic order", async () => {
    const repository = new PaperBrokerOrdersRepository(connection.db);
    const fill = (
      clientOrderId: string,
      filledAt: number,
      status: "FILLED" | "PENDING" = "FILLED",
    ) => ({
      clientOrderId,
      symbol: "NSE:RELIANCE-EQ",
      side: "BUY" as const,
      qty: 1,
      type: "MARKET" as const,
      status,
      ...(status === "FILLED"
        ? {
            filledPrice: 100,
            filledQty: 1,
            slippage: 0,
            charges: 1,
            filledAt,
          }
        : {}),
      recordedAt: filledAt,
    });
    await repository.record(fill("older", 99));
    await repository.record(fill("at-boundary-b", 100));
    await repository.record(fill("at-boundary-a", 100));
    await repository.record(fill("pending", 101, "PENDING"));

    expect(
      (await repository.filledSince(100)).map((order) => order.clientOrderId),
    ).toEqual(["at-boundary-a", "at-boundary-b"]);
  });

  it("finds only pending LIMIT orders for tick monitoring and session expiry", async () => {
    const repository = new PaperBrokerOrdersRepository(connection.db);
    await repository.record({
      clientOrderId: "pending_limit",
      symbol: "NSE:RELIANCE-EQ",
      side: "BUY",
      qty: 1,
      type: "LIMIT",
      price: 99,
      status: "PENDING",
      brokerOrderId: "paper-limit",
      recordedAt: 100,
    });
    await repository.record({
      clientOrderId: "filled_limit",
      symbol: "NSE:RELIANCE-EQ",
      side: "BUY",
      qty: 1,
      type: "LIMIT",
      price: 99,
      status: "FILLED",
      recordedAt: 101,
    });
    await repository.record({
      clientOrderId: "pending_market",
      symbol: "NSE:RELIANCE-EQ",
      side: "BUY",
      qty: 1,
      type: "MARKET",
      status: "PENDING",
      recordedAt: 102,
    });

    expect(
      (await repository.findPending()).map((order) => order.clientOrderId),
    ).toEqual(["pending_limit"]);
  });
});
