import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "./test-support/infra.js";
import {
  COLLECTIONS,
  ensureIndexes,
  NotificationsRepository,
  TTL,
  type MongoConnection,
  type NotificationRecord,
} from "./index.js";

const MONGO_URI =
  process.env["MONGO_URI"] ??
  "mongodb://localhost:27017/neelkanth_notifications_test";

let probe: MongoProbe | undefined;
let connection: MongoConnection;

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_notifications",
    "packages/db/src/notifications-repository.integration.test.ts",
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
  await connection.db.collection(COLLECTIONS.notifications).deleteMany({});
});

afterAll(async () => {
  await closeProbe(probe);
});

const record = (
  overrides: Partial<NotificationRecord> = {},
): NotificationRecord => ({
  notificationId: "ntf_1",
  ts: 1_730_000_000_000,
  severity: "CRITICAL",
  mode: "paper",
  title: "Trading halted (kill)",
  body: "operator kill switch",
  outcome: "sent",
  attempts: 1,
  ...overrides,
});

describe("NotificationsRepository (task 16.6)", () => {
  it("keeps every outcome and reads them back most recent first", async () => {
    const repo = new NotificationsRepository(connection.db);
    await repo.record(record({ notificationId: "ntf_a", ts: 1000 }));
    await repo.record(
      record({
        notificationId: "ntf_b",
        ts: 3000,
        outcome: "failed",
        attempts: 3,
        reason: "HTTP 502: Bad Gateway",
      }),
    );
    await repo.record(
      record({
        notificationId: "ntf_c",
        ts: 2000,
        severity: "INFO",
        outcome: "dropped",
        attempts: 0,
        reason: "notification queue full",
      }),
    );

    const recent = await repo.findRecent(10);
    expect(recent.map((r) => [r.notificationId, r.outcome])).toEqual([
      ["ntf_b", "failed"],
      ["ntf_c", "dropped"],
      ["ntf_a", "sent"],
    ]);
    expect(recent[0]).toEqual(
      record({
        notificationId: "ntf_b",
        ts: 3000,
        outcome: "failed",
        attempts: 3,
        reason: "HTTP 502: Bad Gateway",
      }),
    );
  });

  /**
   * The registry's 90-day TTL index reads `createdAt`, and MongoDB expires a
   * document only when that field is a BSON Date. Stored as a number, the
   * collection would keep everything forever and nothing would say so.
   */
  it("stores createdAt as a Date the TTL index can expire", async () => {
    const repo = new NotificationsRepository(connection.db);
    await repo.record(record({ ts: 1_730_000_000_000 }));
    const raw = await connection.db
      .collection(COLLECTIONS.notifications)
      .findOne({ notificationId: "ntf_1" });
    expect(raw?.["createdAt"]).toBeInstanceOf(Date);
    expect((raw?.["createdAt"] as Date).getTime()).toBe(1_730_000_000_000);

    const indexes = await connection.db
      .collection(COLLECTIONS.notifications)
      .indexes();
    expect(indexes).toContainEqual(
      expect.objectContaining({
        key: { createdAt: 1 },
        expireAfterSeconds: TTL.notifications,
      }),
    );
  });

  it("says a keyed message was sent only when it was delivered", async () => {
    const repo = new NotificationsRepository(connection.db);
    await repo.record(
      record({
        notificationId: "ntf_f",
        dedupeKey: "summary:2026-11-02",
        outcome: "failed",
        attempts: 3,
      }),
    );
    // A failure may go again.
    expect(await repo.wasSent("summary:2026-11-02")).toBe(false);
    await repo.record(
      record({ notificationId: "ntf_s", dedupeKey: "summary:2026-11-02" }),
    );
    expect(await repo.wasSent("summary:2026-11-02")).toBe(true);
    expect(await repo.wasSent("summary:2026-11-03")).toBe(false);
  });

  it("refuses a record that is not one", async () => {
    const repo = new NotificationsRepository(connection.db);
    await expect(
      repo.record({ ...record(), outcome: "maybe" as "sent" }),
    ).rejects.toThrow();
  });
});
