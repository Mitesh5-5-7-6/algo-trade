import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { NotificationsRepository } from "@neelkanth/db";
import { createNotifier } from "./create.js";
import {
  QueuedNotifier,
  type DeliveryOutcome,
  type Notification,
} from "./notifier.js";
import { recordOf } from "./record.js";

/**
 * Notifications from a CLI (Phase 16, task 16.9; design §5.1 D10, §5.3 Q3).
 *
 * A research or paper CLI says what it has just kept, from its own process,
 * with the notifier the API uses and the Telegram settings of its own env
 * file. It never reaches the trading process or its bus, so it cannot reach
 * the order path (D2). Each message's fate is kept in the CLI's own database
 * (D7) — not the trading one `GET /notifications` reads.
 */

export interface CliNotifyDeps {
  /** The CLI's own database: where each message's fate is kept. */
  readonly db: Db;
  /** The CLI's environment, from its env file. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** How long to wait for delivery before the CLI exits. Default 20 s. */
  readonly timeoutMs?: number;
  /** Test seams. */
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

const set = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

/**
 * Send what the CLI kept, wait for it, and keep each outcome. Returns one
 * line for the CLI to print. Never throws: what it tells of is already kept,
 * and a dead Telegram must not turn a finished run into a failed one.
 */
export async function notifyFromCli(
  notifications: readonly Notification[],
  deps: CliNotifyDeps,
): Promise<string> {
  if (notifications.length === 0) return "nothing to tell";
  const config = {
    TELEGRAM_BOT_TOKEN: set(deps.env["TELEGRAM_BOT_TOKEN"]),
    TELEGRAM_CHAT_ID: set(deps.env["TELEGRAM_CHAT_ID"]),
    TELEGRAM_TRADES_CHAT_ID: set(deps.env["TELEGRAM_TRADES_CHAT_ID"]),
  };
  const now = deps.now ?? Date.now;
  const outcomes: DeliveryOutcome[] = [];
  const writes: Promise<boolean>[] = [];
  let timer: NodeJS.Timeout | undefined;
  try {
    const repo = new NotificationsRepository(deps.db);
    const notifier = createNotifier(
      config,
      () => undefined, // every failure is an outcome, summed up below
      (outcome) => {
        outcomes.push(outcome);
        writes.push(
          repo.record(recordOf(outcome, `ntf_${randomUUID()}`, now())).then(
            () => true,
            () => false,
          ),
        );
      },
      {
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      },
    );
    if (!notifier.enabled)
      return "off — TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not both set";

    for (const n of notifications) notifier.notify(n);
    const timeoutMs = deps.timeoutMs ?? 20_000;
    const done =
      notifier instanceof QueuedNotifier ? notifier.idle() : Promise.resolve();
    const finished = await Promise.race([
      done.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
        timer.unref();
      }),
    ]);
    const kept = await Promise.all(writes);

    const count = (o: DeliveryOutcome["outcome"]) =>
      outcomes.filter((x) => x.outcome === o).length;
    const parts = [`sent ${String(count("sent"))}`];
    const failed = outcomes.find((o) => o.outcome !== "sent");
    if (failed !== undefined)
      parts.push(
        `not sent ${String(outcomes.length - count("sent"))} (${failed.reason ?? failed.outcome})`,
      );
    if (!finished)
      parts.push(
        `${String(notifications.length - outcomes.length)} still queued after ${String(timeoutMs)} ms`,
      );
    const unkept = kept.filter((k) => !k).length;
    if (unkept > 0) parts.push(`${String(unkept)} not recorded`);
    return parts.join(", ");
  } catch (error) {
    return `not sent: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearTimeout(timer);
  }
}
