import {
  istDateKey,
  minuteOfDayIST,
  parseHHMM,
  type TradeMode,
} from "@neelkanth/core";
import type { TokenLookup } from "../engines/token-watch.js";
import type { Notifier, Severity } from "./notifier.js";

/**
 * The two scheduled messages (Phase 16, task 16.5; design §5.2), both on the
 * IST clock:
 *
 * - Before the open (default 09:00–09:15): whether a broker token exists. Its
 *   expiry is stated as unknown — the stored one is assumed, not the token's
 *   own, until task 15.4.
 * - After the close (default from 15:45): the day's Trades, P&L, rejections,
 *   risk blocks and reconciliation result, read from storage.
 *
 * Clock-driven rather than hung on MARKET_CLOSE: that event is published
 * before the close's last fills drain and before the close reconciliation
 * runs, so a summary triggered by it would race the facts it reports. Read
 * from storage rather than counted in memory, so a mid-session restart does
 * not quietly halve the day.
 *
 * Each message is sent once per trading day — across restarts too, when
 * `alreadySent` reads the kept record (task 16.6).
 */

export interface DaySummary {
  /** Trades entered today. */
  readonly trades: number;
  readonly closed: number;
  readonly wins: number;
  readonly losses: number;
  /** Net of charges, over the closed Trades. */
  readonly netPnl: number;
  readonly rejections: number;
  readonly riskBlocks: number;
  /** Paper's close reconciliation; Live has none yet (task 15.2). */
  readonly reconciliation: "clean" | "mismatch" | "not run" | "not applicable";
}

export interface DailyMessagesDeps {
  readonly notifier: Notifier;
  readonly mode: TradeMode;
  readonly includeInfo: boolean;
  readonly isTradingDay: (dateKey: string) => Promise<boolean>;
  /** Absent when no broker is configured: there is no token to speak of. */
  readonly tokenStatus?: () => Promise<TokenLookup>;
  readonly readSummary: (dateKey: string) => Promise<DaySummary>;
  /**
   * Whether a message with this key was already delivered (task 16.6), so a
   * restart after the summary time does not send the day summary twice.
   * Absent means in-memory only.
   */
  readonly alreadySent?: (dedupeKey: string) => Promise<boolean>;
  /** IST "HH:MM" — the token message's window opens. Default 09:00. */
  readonly preOpenAt?: string;
  /** IST "HH:MM" — the token message's window closes (the open). Default 09:15. */
  readonly openAt?: string;
  /** IST "HH:MM" — the summary's earliest time. Default 15:45. */
  readonly summaryAt?: string;
  readonly onError: (error: unknown, context: Record<string, unknown>) => void;
}

const inr = (value: number): string =>
  `${value < 0 ? "-" : "+"}₹${Math.abs(value).toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  })}`;

export function formatSummary(
  dateKey: string,
  s: DaySummary,
): {
  severity: Severity;
  title: string;
  body: string;
} {
  const lines = [
    s.trades === 0
      ? "No trades."
      : `${String(s.trades)} trades, ${String(s.closed)} closed: ${String(s.wins)} won, ${String(s.losses)} lost.`,
    `Net P&L ${inr(s.netPnl)}.`,
    `${String(s.rejections)} orders rejected, ${String(s.riskBlocks)} signals blocked by risk.`,
    `Reconciliation: ${s.reconciliation}.`,
  ];
  return {
    // A mismatch is the one finding here that needs the operator tonight.
    severity: s.reconciliation === "mismatch" ? "WARNING" : "INFO",
    title: `Day summary ${dateKey}`,
    body: lines.join("\n"),
  };
}

/**
 * One check of the clock; call it on an interval. Returns nothing and never
 * throws — failures go to `onError` (D2).
 */
export function createDailyMessages(deps: DailyMessagesDeps): {
  tick(now: number): Promise<void>;
} {
  const preOpen = parseHHMM(deps.preOpenAt ?? "09:00");
  const open = parseHHMM(deps.openAt ?? "09:15");
  const summaryAt = parseHHMM(deps.summaryAt ?? "15:45");
  let tokenSentFor: string | null = null;
  let summarySentFor: string | null = null;

  const send = (
    severity: Severity,
    title: string,
    body: string,
    dedupeKey: string,
  ): void => {
    if (severity === "INFO" && !deps.includeInfo) return;
    deps.notifier.notify({ severity, mode: deps.mode, title, body, dedupeKey });
  };
  const sentBefore = async (dedupeKey: string): Promise<boolean> =>
    deps.alreadySent === undefined ? false : deps.alreadySent(dedupeKey);

  return {
    async tick(now) {
      const day = istDateKey(now);
      const minute = minuteOfDayIST(now);
      try {
        const tokenStatus = deps.tokenStatus;
        const tokenDue =
          tokenStatus !== undefined &&
          tokenSentFor !== day &&
          minute >= preOpen &&
          minute < open;
        const summaryDue = summarySentFor !== day && minute >= summaryAt;
        if (!tokenDue && !summaryDue) return;
        if (!(await deps.isTradingDay(day))) return;

        if (tokenDue && !(await sentBefore(`token:${day}`))) {
          tokenSentFor = day;
          const status = await tokenStatus();
          if (status === "present") {
            send(
              "INFO",
              "Broker token present for today's session",
              "Its expiry is not known yet (task 15.4): reconnect if the feed drops.",
              `token:${day}`,
            );
          } else {
            send(
              "WARNING",
              `Broker token ${status === "expired" ? "expired" : "missing"} before the open`,
              "Reconnect the broker from Settings before 09:15, or the feed and orders will not start.",
              `token:${day}`,
            );
          }
        }
        if (summaryDue) {
          summarySentFor = day;
          if (!(await sentBefore(`summary:${day}`))) {
            const message = formatSummary(day, await deps.readSummary(day));
            send(
              message.severity,
              message.title,
              message.body,
              `summary:${day}`,
            );
          }
        }
      } catch (error) {
        deps.onError(error, { where: "notifications.daily", day });
      }
    },
  };
}
