import type { Config } from "@neelkanth/config";
import {
  DISABLED_NOTIFIER,
  QueuedNotifier,
  type Notifier,
} from "./notifier.js";
import { TelegramTransport } from "./telegram.js";

/**
 * The notifier this deployment's configuration asks for (design §5 D5):
 * Telegram when both variables are set — config refuses one without the
 * other — and the disabled notifier when neither is.
 */
export function createNotifier(
  config: Pick<Config, "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID">,
  onError: (error: unknown, context: Record<string, unknown>) => void,
): Notifier {
  const botToken = config.TELEGRAM_BOT_TOKEN;
  const chatId = config.TELEGRAM_CHAT_ID;
  if (botToken === undefined || chatId === undefined) return DISABLED_NOTIFIER;
  return new QueuedNotifier({
    transport: new TelegramTransport({ botToken, chatId }),
    onError,
  });
}
