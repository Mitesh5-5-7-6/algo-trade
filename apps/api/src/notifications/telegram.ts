import type {
  Chat,
  Notification,
  NotificationTransport,
  SendResult,
} from "./notifier.js";

/**
 * Telegram Bot API delivery (Phase 16, design §5 D5–D6).
 *
 * Facts relied on, from core.telegram.org (read 2026-11-02):
 * - Requests go to `https://api.telegram.org/bot<token>/METHOD_NAME`; every
 *   response is JSON with a Boolean `ok`, and on failure a `description`, an
 *   `error_code`, and optionally `parameters`.
 * - `parameters.retry_after`: "In case of exceeding flood control, the number
 *   of seconds left to wait before the request can be repeated".
 * - `sendMessage` takes `chat_id`, `text` ("1-4096 characters after entities
 *   parsing"), `link_preview_options` and `disable_notification` ("Users will
 *   receive a notification with no sound").
 *
 * Plain text, no `parse_mode`: a message is built from event data, and an
 * unescaped `_` or `*` under Markdown would make Telegram refuse the whole
 * message — a CRITICAL lost to formatting.
 */

export interface TelegramTransportDeps {
  /** Secret: it sits in the URL path. Never logged, never in a reason. */
  readonly botToken: string;
  /** Each chat's id (D8). Both may be the same chat. */
  readonly chatIds: Readonly<Record<Chat, string>>;
  /** Default 10 s. A hung request must not hold the queue forever. */
  readonly timeoutMs?: number;
  /** Test seam. */
  readonly fetch?: typeof fetch;
}

/** Telegram's limit on a message's text. */
export const TELEGRAM_TEXT_LIMIT = 4096;

/**
 * `[PAPER] CRITICAL — title`, then the body. The mode leads (D4) so a paper
 * alert can never be read as a live one.
 */
export function formatNotification(notification: Notification): string {
  const head = `[${notification.mode.toUpperCase()}] ${notification.severity} — ${notification.title}`;
  const text =
    notification.body === undefined || notification.body === ""
      ? head
      : `${head}\n${notification.body}`;
  // UTF-16 length is never shorter than Telegram's character count, so this
  // cut can only err on the side of fitting.
  return text.length <= TELEGRAM_TEXT_LIMIT
    ? text
    : `${text.slice(0, TELEGRAM_TEXT_LIMIT - 1)}…`;
}

interface TelegramReply {
  ok?: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TelegramTransport implements NotificationTransport {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetch: typeof fetch;

  constructor(private readonly deps: TelegramTransportDeps) {
    this.url = `https://api.telegram.org/bot${deps.botToken}/sendMessage`;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
    this.fetch = deps.fetch ?? fetch;
  }

  async send(notification: Notification): Promise<SendResult> {
    let response: Response;
    try {
      response = await this.fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.deps.chatIds[notification.chat ?? "operations"],
          text: formatNotification(notification),
          link_preview_options: { is_disabled: true },
          // Fills and closes arrive silently; anything needing attention rings.
          disable_notification: notification.severity === "INFO",
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return {
        ok: false,
        retryable: true,
        reason: this.scrub(
          `network: ${error instanceof Error ? error.message : String(error)}`,
        ),
      };
    }

    const reply = await readReply(response);
    if (reply?.ok === true) return { ok: true };

    const status = reply?.error_code ?? response.status;
    const reason = this.scrub(
      `HTTP ${String(status)}${reply?.description === undefined ? "" : `: ${reply.description}`}`,
    );
    const retryAfter = reply?.parameters?.retry_after;
    if (status === 429) {
      return {
        ok: false,
        retryable: true,
        reason,
        ...(typeof retryAfter === "number" && retryAfter >= 0
          ? { retryAfterMs: retryAfter * 1000 }
          : {}),
      };
    }
    // A server error may clear; a 4xx (a bad token, a chat the bot cannot
    // reach) will say the same thing every time, so retrying only delays the
    // next message.
    return { ok: false, retryable: status >= 500, reason };
  }

  /** The token must never leave in a reason, however an error phrased it. */
  private scrub(text: string): string {
    return text.split(this.deps.botToken).join("<bot-token>");
  }
}

async function readReply(response: Response): Promise<TelegramReply | null> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null ? body : null;
  } catch {
    return null;
  }
}
