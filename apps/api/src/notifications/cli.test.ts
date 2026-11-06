import type { Db } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { notifyFromCli } from "./cli.js";
import type { Notification } from "./notifier.js";

/** Task 16.9 (design §5.1 D10, §5.3 Q3) — a CLI telling what it kept. */

const TOKEN = "123456789:AAH-secret_token";
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "-100ops" };

const declared: Notification = {
  severity: "INFO",
  mode: "research",
  title: "Candidate declared: SC-0003 (RSI)",
  body: "2 variants",
  chat: "operations",
};

/** A database whose `notifications` keeps what is written to it. */
function fakeDb(opts: { failWrites?: boolean } = {}) {
  const kept: Record<string, unknown>[] = [];
  const db = {
    collection: () => ({
      insertOne: (doc: Record<string, unknown>) =>
        opts.failWrites === true
          ? Promise.reject(new Error("not primary"))
          : Promise.resolve(kept.push(doc)),
    }),
  } as unknown as Db;
  return { db, kept };
}

const ok = () =>
  vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ ok: true })));

const instant = () => Promise.resolve();

describe("notifyFromCli (16.9)", () => {
  it("is off, and says so, when Telegram is not configured", async () => {
    const { db, kept } = fakeDb();
    const fetchImpl = ok();
    expect(
      await notifyFromCli([declared], { db, env: {}, fetch: fetchImpl }),
    ).toBe("off — TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not both set");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(kept).toEqual([]);
  });

  it("sends to the operations chat, then keeps the record in the CLI's database", async () => {
    const { db, kept } = fakeDb();
    const fetchImpl = ok();
    expect(
      await notifyFromCli([declared], {
        db,
        env: { ...ENV, TELEGRAM_TRADES_CHAT_ID: "-100trades" },
        fetch: fetchImpl,
        now: () => 1_000,
      }),
    ).toBe("sent 1");
    const sent = fetchImpl.mock.calls[0]?.[1]?.body;
    const body = JSON.parse(typeof sent === "string" ? sent : "{}") as Record<
      string,
      unknown
    >;
    expect(body["chat_id"]).toBe("-100ops");
    expect(body["text"]).toBe(
      "[RESEARCH] INFO — Candidate declared: SC-0003 (RSI)\n2 variants",
    );
    expect(kept).toEqual([
      expect.objectContaining({
        ts: 1_000,
        mode: "research",
        outcome: "sent",
        chat: "operations",
        title: declared.title,
      }),
    ]);
  });

  it("reports a refusal without throwing, and keeps it as failed", async () => {
    const { db, kept } = fakeDb();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 401,
          description: "Unauthorized",
        }),
        { status: 401 },
      ),
    );
    expect(
      await notifyFromCli([declared], { db, env: ENV, fetch: fetchImpl }),
    ).toBe("sent 0, not sent 1 (HTTP 401: Unauthorized)");
    expect(kept).toEqual([expect.objectContaining({ outcome: "failed" })]);
  });

  it("never throws when the network is down, and never leaks the token", async () => {
    const { db } = fakeDb();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}`),
      );
    const line = await notifyFromCli([declared], {
      db,
      env: ENV,
      fetch: fetchImpl,
      sleep: instant,
    });
    expect(line).toMatch(/^sent 0, not sent 1 \(network: /);
    expect(line).not.toContain(TOKEN);
  });

  it("gives up waiting after its timeout, and says what is still queued", async () => {
    const { db } = fakeDb();
    const hung = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise<Response>(() => undefined));
    expect(
      await notifyFromCli([declared], {
        db,
        env: ENV,
        fetch: hung,
        timeoutMs: 50,
      }),
    ).toBe("sent 0, 1 still queued after 50 ms");
  });

  it("says when a record could not be kept, the message still sent", async () => {
    const { db } = fakeDb({ failWrites: true });
    expect(await notifyFromCli([declared], { db, env: ENV, fetch: ok() })).toBe(
      "sent 1, 1 not recorded",
    );
  });

  it("has nothing to tell when given nothing", async () => {
    const { db } = fakeDb();
    expect(await notifyFromCli([], { db, env: ENV })).toBe("nothing to tell");
  });
});
