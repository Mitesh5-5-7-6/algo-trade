import { describe, expect, it } from "vitest";
import {
  DISABLED_NOTIFIER,
  QueuedNotifier,
  type DeliveryOutcome,
  type Notification,
  type NotificationTransport,
  type SendResult,
  type Severity,
} from "./notifier.js";
import { chatOf, createNotifier } from "./create.js";

/** Task 16.2 — the port and its bounded, paced queue (design §5 D2, D6). */

const note = (severity: Severity, title: string = severity): Notification => ({
  severity,
  mode: "paper",
  title,
});

/**
 * A transport that answers from a script, records what it was asked to send,
 * and can be held so a test can fill the queue behind an in-flight send.
 */
function scriptedTransport(script: SendResult[] = []) {
  const sent: string[] = [];
  let release: (() => void) | null = null;
  let held: Promise<void> | null = null;
  const transport: NotificationTransport = {
    async send(notification) {
      sent.push(notification.title);
      if (held !== null) await held;
      return script.shift() ?? { ok: true };
    },
  };
  return {
    transport,
    sent,
    hold() {
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release() {
      held = null;
      release?.();
    },
  };
}

function harness(
  opts: { script?: SendResult[]; capacity?: number; maxAttempts?: number } = {},
) {
  const t = scriptedTransport(opts.script);
  const sleeps: number[] = [];
  const errors: { error: unknown; context: Record<string, unknown> }[] = [];
  const notifier = new QueuedNotifier({
    transport: t.transport,
    ...(opts.capacity === undefined ? {} : { capacity: opts.capacity }),
    ...(opts.maxAttempts === undefined
      ? {}
      : { maxAttempts: opts.maxAttempts }),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    onError: (error, context) => errors.push({ error, context }),
  });
  return { notifier, t, sleeps, errors };
}

describe("QueuedNotifier (task 16.2)", () => {
  it("delivers what it is given and counts it", async () => {
    const h = harness();
    h.notifier.notify(note("INFO", "filled"));
    await h.notifier.idle();
    expect(h.t.sent).toEqual(["filled"]);
    expect(h.notifier.stats()).toEqual({
      sent: 1,
      failed: 0,
      dropped: 0,
      queued: 0,
    });
  });

  /** D2: notify is fire-and-forget — it returns before any delivery happens. */
  it("never waits on delivery: notify returns while a send is still in flight", () => {
    const h = harness();
    h.t.hold();
    h.notifier.notify(note("CRITICAL", "halted"));
    // Back in the caller already: the send has started and not finished.
    expect(h.t.sent).toEqual(["halted"]);
    expect(h.notifier.stats().sent).toBe(0);
    h.t.release();
  });

  /** Telegram: no more than one message per second in a chat (Bot FAQ). */
  it("paces consecutive sends by the minimum interval", async () => {
    const h = harness();
    h.notifier.notify(note("INFO", "a"));
    h.notifier.notify(note("INFO", "b"));
    h.notifier.notify(note("INFO", "c"));
    await h.notifier.idle();
    expect(h.t.sent).toEqual(["a", "b", "c"]);
    expect(h.sleeps).toEqual([1000, 1000]);
  });

  it("sends a CRITICAL ahead of less urgent messages still waiting", async () => {
    const h = harness();
    h.t.hold();
    h.notifier.notify(note("INFO", "in flight"));
    h.notifier.notify(note("INFO", "fill"));
    h.notifier.notify(note("WARNING", "rejected"));
    h.notifier.notify(note("CRITICAL", "halted"));
    h.t.release();
    await h.notifier.idle();
    expect(h.t.sent).toEqual(["in flight", "halted", "rejected", "fill"]);
  });

  describe("when the queue is full (D6)", () => {
    it("drops the oldest INFO to admit something more urgent", async () => {
      const h = harness({ capacity: 2 });
      h.t.hold();
      h.notifier.notify(note("INFO", "in flight")); // taken off the queue
      h.notifier.notify(note("INFO", "old info"));
      h.notifier.notify(note("INFO", "new info"));
      h.notifier.notify(note("CRITICAL", "halted"));
      h.t.release();
      await h.notifier.idle();
      expect(h.t.sent).toEqual(["in flight", "halted", "new info"]);
      expect(h.notifier.stats().dropped).toBe(1);
      expect(h.errors[0]?.context).toMatchObject({
        where: "notifier.queue",
        title: "old info",
      });
    });

    it("drops the arrival itself when it is the least urgent there", async () => {
      const h = harness({ capacity: 1 });
      h.t.hold();
      h.notifier.notify(note("INFO", "in flight"));
      h.notifier.notify(note("CRITICAL", "halted"));
      h.notifier.notify(note("INFO", "fill"));
      h.t.release();
      await h.notifier.idle();
      expect(h.t.sent).toEqual(["in flight", "halted"]);
      expect(h.errors[0]?.context).toMatchObject({ title: "fill" });
    });

    it("never holds more than its capacity", () => {
      const h = harness({ capacity: 3 });
      h.t.hold();
      for (let i = 0; i < 10; i += 1)
        h.notifier.notify(note("WARNING", `w${String(i)}`));
      // One in flight, three held, the rest dropped and counted.
      expect(h.notifier.stats().queued).toBe(3);
      expect(h.notifier.stats().dropped).toBe(6);
      h.t.release();
    });
  });

  describe("failures are counted and reported, never thrown (D2)", () => {
    it("waits as long as the service says, then retries", async () => {
      const h = harness({
        script: [
          {
            ok: false,
            retryable: true,
            retryAfterMs: 7000,
            reason: "HTTP 429",
          },
          { ok: true },
        ],
      });
      h.notifier.notify(note("CRITICAL", "halted"));
      await h.notifier.idle();
      expect(h.t.sent).toEqual(["halted", "halted"]);
      expect(h.sleeps).toEqual([7000]);
      expect(h.notifier.stats()).toMatchObject({ sent: 1, failed: 0 });
    });

    it("gives up after its attempts, reports it, and moves on to the next", async () => {
      const failure: SendResult = {
        ok: false,
        retryable: true,
        reason: "HTTP 502",
      };
      const h = harness({
        script: [failure, failure, failure],
        maxAttempts: 3,
      });
      h.notifier.notify(note("WARNING", "rejected"));
      h.notifier.notify(note("INFO", "next"));
      await h.notifier.idle();
      expect(h.t.sent).toEqual(["rejected", "rejected", "rejected", "next"]);
      expect(h.notifier.stats()).toMatchObject({ sent: 1, failed: 1 });
      expect(h.errors[0]?.context).toMatchObject({
        where: "notifier.deliver",
        attempts: 3,
      });
    });

    it("does not retry a permanent refusal", async () => {
      const h = harness({
        script: [{ ok: false, retryable: false, reason: "HTTP 403: blocked" }],
      });
      h.notifier.notify(note("CRITICAL"));
      await h.notifier.idle();
      expect(h.t.sent).toHaveLength(1);
      expect(h.notifier.stats().failed).toBe(1);
    });

    it("survives a transport that throws, and keeps delivering", async () => {
      let calls = 0;
      const errors: unknown[] = [];
      const notifier = new QueuedNotifier({
        transport: {
          send: () => {
            calls += 1;
            return calls === 1
              ? Promise.reject(new Error("boom"))
              : Promise.resolve({ ok: true });
          },
        },
        maxAttempts: 1,
        sleep: () => Promise.resolve(),
        onError: (error) => errors.push(error),
      });
      expect(() => {
        notifier.notify(note("CRITICAL", "a"));
      }).not.toThrow();
      notifier.notify(note("CRITICAL", "b"));
      await notifier.idle();
      expect(notifier.stats()).toMatchObject({ sent: 1, failed: 1 });
      expect(errors).toHaveLength(1);
    });
  });
});

describe("every message's fate is reported, to be kept (task 16.6)", () => {
  it("reports sent, failed and dropped, with attempts and reason", async () => {
    const outcomes: DeliveryOutcome[] = [];
    const t = scriptedTransport([
      { ok: true },
      { ok: false, retryable: false, reason: "HTTP 403: blocked" },
    ]);
    t.hold();
    const notifier = new QueuedNotifier({
      transport: t.transport,
      capacity: 1,
      sleep: () => Promise.resolve(),
      onError: () => undefined,
      onOutcome: (o) => outcomes.push(o),
    });
    notifier.notify(note("CRITICAL", "halted")); // in flight → sent
    notifier.notify(note("WARNING", "rejected")); // queued → failed
    notifier.notify(note("INFO", "fill")); // queue full → dropped
    t.release();
    await notifier.idle();

    expect(
      outcomes.map((o) => [
        o.notification.title,
        o.outcome,
        o.attempts,
        o.reason,
      ]),
    ).toEqual([
      ["fill", "dropped", 0, "notification queue full"],
      ["halted", "sent", 1, undefined],
      ["rejected", "failed", 1, "HTTP 403: blocked"],
    ]);
  });

  it("keeps delivering when keeping the record throws", async () => {
    const errors: unknown[] = [];
    const t = scriptedTransport();
    const notifier = new QueuedNotifier({
      transport: t.transport,
      sleep: () => Promise.resolve(),
      onError: (error) => errors.push(error),
      onOutcome: () => {
        throw new Error("mongo down");
      },
    });
    notifier.notify(note("CRITICAL", "a"));
    notifier.notify(note("CRITICAL", "b"));
    await notifier.idle();
    expect(t.sent).toEqual(["a", "b"]);
    expect(notifier.stats().sent).toBe(2);
    expect(errors).toHaveLength(2);
  });
});

describe("createNotifier (D5)", () => {
  it("is the disabled notifier when Telegram is not configured", () => {
    const notifier = createNotifier({}, () => undefined);
    expect(notifier).toBe(DISABLED_NOTIFIER);
    expect(notifier.enabled).toBe(false);
    expect(() => {
      notifier.notify(note("CRITICAL"));
    }).not.toThrow();
  });

  it("is a live queue when both the bot and the chat are set", () => {
    const notifier = createNotifier(
      { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" },
      () => undefined,
    );
    expect(notifier).toBeInstanceOf(QueuedNotifier);
    expect(notifier.enabled).toBe(true);
  });
});

describe("chatOf — where a message goes (16.8, D8)", () => {
  const trade: Notification = { ...note("INFO"), chat: "trades" };

  it("sends trades to the trades chat when one is configured", () => {
    expect(chatOf(trade, "@trades")).toBe("trades");
  });

  it("sends trades to the operations chat while none is", () => {
    expect(chatOf(trade, undefined)).toBe("operations");
  });

  it("keeps everything else in operations, whatever is configured", () => {
    for (const trades of ["@trades", undefined]) {
      expect(chatOf(note("CRITICAL"), trades)).toBe("operations");
      expect(chatOf({ ...note("WARNING"), chat: "operations" }, trades)).toBe(
        "operations",
      );
    }
  });
});
