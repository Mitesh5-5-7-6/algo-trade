import { describe, expect, it, vi } from "vitest";
import type { Notification } from "./notifier.js";
import {
  TELEGRAM_TEXT_LIMIT,
  TelegramTransport,
  formatNotification,
} from "./telegram.js";

/** Task 16.2 — the Telegram transport (design §5 D4–D6). */

const TOKEN = "123456789:AAH-secret_token";

const critical: Notification = {
  severity: "CRITICAL",
  mode: "live",
  title: "trading halted",
  body: "reconciliation mismatch on NSE:NIFTY-INDEX",
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The JSON a request carried — the transport always sends a string. */
function bodyOf(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : "";
}

function transport(fetchImpl: typeof fetch, timeoutMs?: number) {
  return new TelegramTransport({
    botToken: TOKEN,
    chatIds: { operations: "-1001234", trades: "@trades" },
    fetch: fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe("formatNotification (D4)", () => {
  it("leads with the mode, then severity and title, then the body", () => {
    expect(formatNotification(critical)).toBe(
      "[LIVE] CRITICAL — trading halted\nreconciliation mismatch on NSE:NIFTY-INDEX",
    );
    expect(
      formatNotification({ severity: "INFO", mode: "paper", title: "filled" }),
    ).toBe("[PAPER] INFO — filled");
  });

  it("fits Telegram's 4096-character limit", () => {
    const text = formatNotification({ ...critical, body: "x".repeat(10_000) });
    expect(text.length).toBe(TELEGRAM_TEXT_LIMIT);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("TelegramTransport (task 16.2)", () => {
  it("posts sendMessage to the bot's URL, plain text, previews off", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply(200, { ok: true, result: {} }));
    expect(await transport(fetchImpl).send(critical)).toEqual({ ok: true });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(bodyOf(init))).toEqual({
      chat_id: "-1001234",
      text: formatNotification(critical),
      link_preview_options: { is_disabled: true },
      disable_notification: false,
    });
  });

  it("sends INFO silently and anything needing attention with sound", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply(200, { ok: true }));
    await transport(fetchImpl).send({ ...critical, severity: "INFO" });
    await transport(fetchImpl).send({ ...critical, severity: "WARNING" });
    const silent = fetchImpl.mock.calls.map(
      ([, init]) =>
        (JSON.parse(bodyOf(init)) as { disable_notification: boolean })
          .disable_notification,
    );
    expect(silent).toEqual([true, false]);
  });

  it("sends each message to its chat — operations unless marked trades (16.8)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply(200, { ok: true }));
    await transport(fetchImpl).send(critical);
    await transport(fetchImpl).send({ ...critical, chat: "operations" });
    await transport(fetchImpl).send({ ...critical, chat: "trades" });
    const chats = fetchImpl.mock.calls.map(
      ([, init]) => (JSON.parse(bodyOf(init)) as { chat_id: string }).chat_id,
    );
    expect(chats).toEqual(["-1001234", "-1001234", "@trades"]);
  });

  /** Bot API ResponseParameters.retry_after: seconds to wait under flood control. */
  it("turns flood control into a retry after the time Telegram names", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      reply(429, {
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 7",
        parameters: { retry_after: 7 },
      }),
    );
    expect(await transport(fetchImpl).send(critical)).toEqual({
      ok: false,
      retryable: true,
      retryAfterMs: 7000,
      reason: "HTTP 429: Too Many Requests: retry after 7",
    });
  });

  it("retries a server error but not a permanent refusal", async () => {
    const server = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        reply(502, { ok: false, error_code: 502, description: "Bad Gateway" }),
      );
    expect(await transport(server).send(critical)).toMatchObject({
      ok: false,
      retryable: true,
    });

    const forbidden = vi.fn<typeof fetch>().mockResolvedValue(
      reply(403, {
        ok: false,
        error_code: 403,
        description: "Forbidden: bot was blocked by the user",
      }),
    );
    expect(await transport(forbidden).send(critical)).toMatchObject({
      ok: false,
      retryable: false,
    });
  });

  it("treats the network failing as retryable", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("ECONNRESET"));
    expect(await transport(fetchImpl).send(critical)).toMatchObject({
      ok: false,
      retryable: true,
      reason: "network: ECONNRESET",
    });
  });

  it("abandons a request that outlives its timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("The operation was aborted due to timeout"));
          });
        }),
    );
    expect(await transport(fetchImpl, 20).send(critical)).toMatchObject({
      ok: false,
      retryable: true,
    });
  });

  /** D5: the token is in the URL, so any error that echoes the URL must be scrubbed. */
  it("never lets the bot token out in a failure reason", async () => {
    const leaky = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new Error(
          `connect failed for https://api.telegram.org/bot${TOKEN}/sendMessage`,
        ),
      );
    const result = await transport(leaky).send(critical);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).toContain("<bot-token>");

    const echoed = vi.fn<typeof fetch>().mockResolvedValue(
      reply(401, {
        ok: false,
        error_code: 401,
        description: `Unauthorized ${TOKEN}`,
      }),
    );
    expect(
      JSON.stringify(await transport(echoed).send(critical)),
    ).not.toContain(TOKEN);
  });
});
