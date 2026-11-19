import { istDateKey, minuteOfDayIST, parseHHMM } from "@neelkanth/core";
import type { TokenLookup } from "../engines/token-watch.js";
import type { Severity } from "../notifications/notifier.js";

/**
 * The morning start (operator decision 2026-11-19): a valid FYERS token
 * before 09:15, so the feed sees the open. On 2026-11-18 and 2026-11-19 the
 * login came at 09:29 and 10:22, and every morning bar arrived late.
 *
 * Two parts, the second backing the first:
 *
 * 1. **An automatic renewal**, tried at 08:40, 08:50 and 09:00 while no valid
 *    token is held — when the deployment has been given the means (the PIN).
 * 2. **A reminder**, at 08:45 and 09:05 while there is still none, saying why
 *    the renewal did not do it and what to do: log in from the dashboard.
 *
 * Nothing here trades or reads trading state. Driven by `tick`, once a minute.
 */

export interface MorningStartDeps {
  isTradingDay: (dateKey: string) => Promise<boolean>;
  tokenStatus: () => Promise<TokenLookup>;
  /**
   * Try to renew the token; resolves to null on success (the token is
   * stored and the feed told), or FYERS's reason. Null itself when the
   * deployment cannot renew — no PIN, or no refresh token stored.
   */
  renew: (() => Promise<string | null>) | null;
  /** Why `renew` is null, for the reminder to say. */
  renewUnavailable?: string;
  notify: (
    severity: Severity,
    title: string,
    body: string,
    dedupeKey: string,
  ) => void;
  onError: (error: unknown, context: Record<string, unknown>) => void;
  renewAt?: readonly string[];
  remindAt?: readonly string[];
  openAt?: string;
}

const RENEW_AT = ["08:40", "08:50", "09:00"] as const;
const REMIND_AT = ["08:45", "09:05"] as const;

export function createMorningStart(deps: MorningStartDeps): {
  tick(now: number): Promise<void>;
} {
  const renewAt = (deps.renewAt ?? RENEW_AT).map(parseHHMM);
  const remindAt = (deps.remindAt ?? REMIND_AT).map(parseHHMM);
  const open = parseHHMM(deps.openAt ?? "09:15");
  const first = Math.min(...renewAt, ...remindAt);

  let day: string | null = null;
  let renewalsTried = 0;
  let remindersSent = 0;
  let lastFailure: string | null = null;
  let renewedToday = false;

  return {
    async tick(now) {
      const minute = minuteOfDayIST(now);
      if (minute < first || minute >= open) return;
      const today = istDateKey(now);
      try {
        if (day !== today) {
          if (!(await deps.isTradingDay(today))) return;
          day = today;
          renewalsTried = 0;
          remindersSent = 0;
          lastFailure = null;
          renewedToday = false;
        }
        if ((await deps.tokenStatus()) === "present") return;

        const renewDue = renewAt[renewalsTried];
        if (
          deps.renew !== null &&
          renewDue !== undefined &&
          minute >= renewDue
        ) {
          renewalsTried += 1;
          const failure = await deps.renew();
          if (failure === null) {
            renewedToday = true;
            deps.notify(
              "INFO",
              "FYERS logged in automatically",
              "A fresh token is stored and the feed is reconnecting before the open.",
              `morning-login:${today}`,
            );
            return;
          }
          lastFailure = failure;
        }

        const remindDue = remindAt[remindersSent];
        if (!renewedToday && remindDue !== undefined && minute >= remindDue) {
          remindersSent += 1;
          const why =
            deps.renew === null
              ? `Automatic login is off: ${deps.renewUnavailable ?? "not configured"}.`
              : lastFailure === null
                ? "Automatic login has not run yet."
                : `Automatic login failed: ${lastFailure}`;
          deps.notify(
            "WARNING",
            "Log in to FYERS before 09:15",
            `${why}\nOpen the dashboard → Settings → Connect FYERS. Until then no market data arrives; bars missed are fetched once you log in.`,
            `login-reminder:${today}:${String(remindersSent)}`,
          );
        }
      } catch (error) {
        deps.onError(error, { where: "morningStart", day: today });
      }
    },
  };
}
