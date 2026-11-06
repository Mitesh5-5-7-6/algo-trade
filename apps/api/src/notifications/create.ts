import type { Config } from "@neelkanth/config";
import {
  DISABLED_NOTIFIER,
  QueuedNotifier,
  type Chat,
  type DeliveryOutcome,
  type Notification,
  type Notifier,
} from "./notifier.js";
import { TelegramTransport } from "./telegram.js";

/**
 * The chat a message actually goes to (design §5.1 D8): trades only when a
 * trades chat is configured; otherwise everything shares the operations chat.
 */
export function chatOf(
  notification: Notification,
  tradesChatId: string | undefined,
): Chat {
  return notification.chat === "trades" && tradesChatId !== undefined
    ? "trades"
    : "operations";
}

/**
 * The notifier this deployment's configuration asks for (design §5 D5):
 * Telegram when both variables are set — config refuses one without the
 * other — and the disabled notifier when neither is. A trades chat is
 * optional (D8); without one, trades go to the operations chat.
 */
export function createNotifier(
  config: Pick<
    Config,
    "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID" | "TELEGRAM_TRADES_CHAT_ID"
  >,
  onError: (error: unknown, context: Record<string, unknown>) => void,
  /** Where each message's fate is kept (task 16.6), naming the chat it went to. */
  onOutcome?: (outcome: DeliveryOutcome) => void,
): Notifier {
  const botToken = config.TELEGRAM_BOT_TOKEN;
  const chatId = config.TELEGRAM_CHAT_ID;
  const tradesChatId = config.TELEGRAM_TRADES_CHAT_ID;
  if (botToken === undefined || chatId === undefined) return DISABLED_NOTIFIER;
  return new QueuedNotifier({
    transport: new TelegramTransport({
      botToken,
      chatIds: { operations: chatId, trades: tradesChatId ?? chatId },
    }),
    onError,
    ...(onOutcome === undefined
      ? {}
      : {
          onOutcome: (outcome: DeliveryOutcome) => {
            onOutcome({
              ...outcome,
              notification: {
                ...outcome.notification,
                chat: chatOf(outcome.notification, tradesChatId),
              },
            });
          },
        }),
  });
}
