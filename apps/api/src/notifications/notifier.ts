import type { TradeMode } from "@neelkanth/core";

/**
 * Operator notifications (Phase 16, design LIVE_READINESS_AND_EXTENSIONS §5).
 *
 * Outbound only (D1), and never on the order path (D2): `notify` is
 * synchronous, never throws and never waits on delivery, so a slow or dead
 * Telegram cannot slow, block or change a trading decision. Delivery happens
 * behind a bounded queue (D6).
 */

/** How urgent: the catalogue in design §5.2 assigns one to every event. */
export type Severity = "CRITICAL" | "WARNING" | "INFO";

/**
 * Which chat a message belongs in (design §5.1 D8): trades — entry fills and
 * closed positions — or operations, everything else.
 */
export type Chat = "operations" | "trades";

/**
 * What a message speaks for (D4): a trading mode, or research — the research
 * CLIs, which are neither paper nor Live (D10, task 16.9).
 */
export type NotificationMode = TradeMode | "research";

export interface Notification {
  readonly severity: Severity;
  /**
   * The deployment's mode (D4) — injected by the caller from the same
   * BROKER_MODE the Order Manager is given, never inferred from a broker
   * object; `research` from a research CLI. Every message leads with it.
   */
  readonly mode: NotificationMode;
  /** One line: what happened. */
  readonly title: string;
  /** Detail, if any. Never a secret, a token or a broker identifier (D5). */
  readonly body?: string;
  /** Set on a message that must go once (task 16.6), e.g. `summary:2026-11-02`. */
  readonly dedupeKey?: string;
  /** Its chat (D8). Absent means operations. */
  readonly chat?: Chat;
}

/** What became of one message (task 16.6, D7). */
export interface DeliveryOutcome {
  readonly notification: Notification;
  readonly outcome: "sent" | "failed" | "dropped";
  readonly attempts: number;
  readonly reason?: string;
}

/** The port the rest of the system sees. */
export interface Notifier {
  /** Whether anything will actually be delivered. */
  readonly enabled: boolean;
  /** Queue a message. Synchronous; never throws; never waits on delivery. */
  notify(notification: Notification): void;
}

/** What one delivery attempt came to. */
export type SendResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** Worth trying again: flood control, a server error, the network. */
      readonly retryable: boolean;
      /** The service's own instruction on when to try again. */
      readonly retryAfterMs?: number;
      /** Already scrubbed of any secret. */
      readonly reason: string;
    };

/** One way of delivering a message — Telegram today. */
export interface NotificationTransport {
  send(notification: Notification): Promise<SendResult>;
}

export interface NotifierStats {
  readonly sent: number;
  readonly failed: number;
  readonly dropped: number;
  readonly queued: number;
}

export interface QueuedNotifierDeps {
  readonly transport: NotificationTransport;
  /** Most messages held at once (D6). Default 200. */
  readonly capacity?: number;
  /**
   * Gap between sends. Telegram asks for no more than one message per second
   * in a chat (Bot FAQ, "My bot is hitting limits"). Default 1000 ms.
   */
  readonly minIntervalMs?: number;
  /** Tries per message for a retryable failure. Default 3. */
  readonly maxAttempts?: number;
  /** Wait used on failure when the service names no retry time. Default 2000 ms. */
  readonly retryBackoffMs?: number;
  /** Test seam. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Told what became of every message — sent, failed or dropped — so it can
   * be kept (task 16.6). Called synchronously; a throw here is reported,
   * never allowed to stop delivery.
   */
  readonly onOutcome?: (outcome: DeliveryOutcome) => void;
  /** Failures and drops are reported here — counted and logged, never thrown (D2). */
  readonly onError: (error: unknown, context: Record<string, unknown>) => void;
}

const RANK: Record<Severity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

/**
 * The bounded, paced delivery queue.
 *
 * Order: a CRITICAL message goes before anything less urgent still waiting;
 * within a severity, first in first out. When full, the oldest message of the
 * LOWEST severity present is dropped to make room — INFO first, CRITICAL last
 * — and an arrival less urgent than everything held is itself the one
 * dropped. Every drop is counted and reported.
 */
export class QueuedNotifier implements Notifier {
  readonly enabled = true;
  private readonly queue: Notification[] = [];
  private readonly capacity: number;
  private readonly minIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly retryBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private draining: Promise<void> | null = null;
  private sent = 0;
  private failed = 0;
  private dropped = 0;

  constructor(private readonly deps: QueuedNotifierDeps) {
    this.capacity = deps.capacity ?? 200;
    this.minIntervalMs = deps.minIntervalMs ?? 1_000;
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.retryBackoffMs = deps.retryBackoffMs ?? 2_000;
    this.sleep =
      deps.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  notify(notification: Notification): void {
    try {
      if (this.queue.length >= this.capacity && !this.makeRoom(notification)) {
        this.drop(notification);
        return;
      }
      this.queue.push(notification);
      this.draining ??= this.drain().finally(() => {
        this.draining = null;
      });
    } catch (error) {
      // Defence in depth: nothing on a caller's path may throw from here.
      this.deps.onError(error, { where: "notifier.notify" });
    }
  }

  stats(): NotifierStats {
    return {
      sent: this.sent,
      failed: this.failed,
      dropped: this.dropped,
      queued: this.queue.length,
    };
  }

  /** Resolves once everything queued so far has been attempted. Test and shutdown seam. */
  async idle(): Promise<void> {
    while (this.draining !== null) await this.draining;
  }

  /** Evict the least urgent message to admit `incoming`; false when `incoming` is the least urgent. */
  private makeRoom(incoming: Notification): boolean {
    let victim = -1;
    for (let i = 0; i < this.queue.length; i += 1) {
      const held = this.queue[i];
      if (held === undefined) continue;
      const worst = victim === -1 ? undefined : this.queue[victim];
      // Strictly greater: the OLDEST of the lowest severity goes first.
      if (worst === undefined || RANK[held.severity] > RANK[worst.severity]) {
        victim = i;
      }
    }
    const worst = victim === -1 ? undefined : this.queue[victim];
    if (worst === undefined || RANK[incoming.severity] > RANK[worst.severity]) {
      return false;
    }
    this.queue.splice(victim, 1);
    this.drop(worst);
    return true;
  }

  private report(outcome: DeliveryOutcome): void {
    try {
      this.deps.onOutcome?.(outcome);
    } catch (error) {
      this.deps.onError(error, { where: "notifier.onOutcome" });
    }
  }

  private drop(notification: Notification): void {
    this.dropped += 1;
    this.report({
      notification,
      outcome: "dropped",
      attempts: 0,
      reason: "notification queue full",
    });
    this.deps.onError(new Error("notification queue full — message dropped"), {
      where: "notifier.queue",
      severity: notification.severity,
      title: notification.title,
      dropped: this.dropped,
    });
  }

  private next(): Notification | undefined {
    let best = -1;
    for (let i = 0; i < this.queue.length; i += 1) {
      const held = this.queue[i];
      const current = best === -1 ? undefined : this.queue[best];
      if (held === undefined) continue;
      if (
        current === undefined ||
        RANK[held.severity] < RANK[current.severity]
      ) {
        best = i;
      }
    }
    return best === -1 ? undefined : this.queue.splice(best, 1)[0];
  }

  private async drain(): Promise<void> {
    let first = true;
    for (
      let notification = this.next();
      notification !== undefined;
      notification = this.next()
    ) {
      if (!first) await this.sleep(this.minIntervalMs);
      first = false;
      await this.deliver(notification);
    }
  }

  private async deliver(notification: Notification): Promise<void> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let result: SendResult;
      try {
        result = await this.deps.transport.send(notification);
      } catch (error) {
        // A transport is meant to report, not throw; treat a throw as a
        // retryable failure so one broken send cannot stop the queue.
        result = {
          ok: false,
          retryable: true,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (result.ok) {
        this.sent += 1;
        this.report({ notification, outcome: "sent", attempts: attempt });
        return;
      }
      const last = !result.retryable || attempt === this.maxAttempts;
      if (last) {
        this.failed += 1;
        this.report({
          notification,
          outcome: "failed",
          attempts: attempt,
          reason: result.reason,
        });
        this.deps.onError(
          new Error(`notification not delivered: ${result.reason}`),
          {
            where: "notifier.deliver",
            severity: notification.severity,
            title: notification.title,
            attempts: attempt,
          },
        );
        return;
      }
      await this.sleep(result.retryAfterMs ?? this.retryBackoffMs);
    }
  }
}

/**
 * The notifier when none is configured (D5): accepts everything, delivers
 * nothing. The composition root says so once at boot, so "off" is a stated
 * fact rather than a silence that looks like a quiet day.
 */
export const DISABLED_NOTIFIER: Notifier = {
  enabled: false,
  notify: () => undefined,
};
