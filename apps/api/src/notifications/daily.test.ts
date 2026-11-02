import { describe, expect, it } from "vitest";
import type { TokenLookup } from "../engines/token-watch.js";
import type { Notification, Notifier } from "./notifier.js";
import {
  createDailyMessages,
  formatSummary,
  type DaySummary,
  type DailyMessagesDeps,
} from "./daily.js";

/** Task 16.5 — the pre-open and post-close messages, on the IST clock. */

/** IST is UTC+5:30: a Wednesday, 2024-01-03, at the given IST time. */
const ist = (hh: number, mm: number) =>
  Date.UTC(2024, 0, 3, hh, mm) - (5 * 60 + 30) * 60_000;

const SUMMARY: DaySummary = {
  trades: 3,
  closed: 2,
  wins: 1,
  losses: 1,
  netPnl: -120.5,
  rejections: 1,
  riskBlocks: 4,
  reconciliation: "clean",
};

function harness(overrides: Partial<DailyMessagesDeps> = {}) {
  const sent: Notification[] = [];
  const errors: unknown[] = [];
  const summaryDays: string[] = [];
  const notifier: Notifier = { enabled: true, notify: (n) => sent.push(n) };
  const daily = createDailyMessages({
    notifier,
    mode: "paper",
    includeInfo: true,
    isTradingDay: () => Promise.resolve(true),
    tokenStatus: () => Promise.resolve<TokenLookup>("present"),
    readSummary: (day) => {
      summaryDays.push(day);
      return Promise.resolve(SUMMARY);
    },
    onError: (error) => errors.push(error),
    ...overrides,
  });
  return { daily, sent, errors, summaryDays };
}

const titles = (sent: Notification[]) =>
  sent.map((n) => `${n.severity} ${n.title}`);

describe("before the open (task 16.5)", () => {
  it("says once, between 09:00 and 09:15 IST, that the token is there", async () => {
    const h = harness();
    await h.daily.tick(ist(8, 59)); // too early
    await h.daily.tick(ist(9, 0));
    await h.daily.tick(ist(9, 5)); // already said today
    expect(titles(h.sent)).toEqual([
      "INFO Broker token present for today's session",
    ]);
    // Expiry is unknown until 15.4 — and the message says so.
    expect(h.sent[0]?.body).toContain("expiry is not known");
  });

  it("warns, with sound, when the token is missing or expired", async () => {
    const h = harness({ tokenStatus: () => Promise.resolve("expired") });
    await h.daily.tick(ist(9, 2));
    expect(titles(h.sent)).toEqual([
      "WARNING Broker token expired before the open",
    ]);
  });

  /** A process started at 11:00 has nothing "before the open" to say. */
  it("says nothing about the token outside the window", async () => {
    const h = harness();
    await h.daily.tick(ist(9, 15));
    await h.daily.tick(ist(11, 0));
    expect(h.sent).toEqual([]);
  });

  it("says nothing about a token when no broker is configured", async () => {
    const sent: Notification[] = [];
    const daily = createDailyMessages({
      notifier: { enabled: true, notify: (n) => sent.push(n) },
      mode: "paper",
      includeInfo: true,
      isTradingDay: () => Promise.resolve(true),
      readSummary: () => Promise.resolve(SUMMARY),
      onError: () => undefined,
    });
    await daily.tick(ist(9, 5));
    expect(sent).toEqual([]);
  });
});

describe("after the close (task 16.5)", () => {
  it("sends the day's summary once, from 15:45 IST, for that IST day", async () => {
    const h = harness();
    await h.daily.tick(ist(15, 40)); // the close is still settling
    await h.daily.tick(ist(15, 45));
    await h.daily.tick(ist(18, 0)); // already sent today
    expect(titles(h.sent)).toEqual(["INFO Day summary 2024-01-03"]);
    expect(h.summaryDays).toEqual(["2024-01-03"]);
  });

  it("sends a new summary the next trading day", async () => {
    const h = harness();
    await h.daily.tick(ist(16, 0));
    await h.daily.tick(ist(16, 0) + 86_400_000);
    expect(h.summaryDays).toEqual(["2024-01-03", "2024-01-04"]);
  });

  it("raises a reconciliation mismatch to WARNING", () => {
    expect(
      formatSummary("2024-01-03", { ...SUMMARY, reconciliation: "mismatch" })
        .severity,
    ).toBe("WARNING");
  });

  it("reads plainly", () => {
    expect(formatSummary("2024-01-03", SUMMARY).body).toBe(
      [
        "3 trades, 2 closed: 1 won, 1 lost.",
        "Net P&L -₹120.5.",
        "1 orders rejected, 4 signals blocked by risk.",
        "Reconciliation: clean.",
      ].join("\n"),
    );
  });
});

describe("the daily messages respect the calendar and the switches (task 16.5)", () => {
  it("says nothing on a holiday or a weekend", async () => {
    const h = harness({ isTradingDay: () => Promise.resolve(false) });
    await h.daily.tick(ist(9, 5));
    await h.daily.tick(ist(16, 0));
    expect(h.sent).toEqual([]);
  });

  it("drops the INFO ones when INFO is off, and keeps the warnings", async () => {
    const h = harness({
      includeInfo: false,
      readSummary: () =>
        Promise.resolve({ ...SUMMARY, reconciliation: "mismatch" as const }),
    });
    await h.daily.tick(ist(9, 5)); // token present: INFO, dropped
    await h.daily.tick(ist(16, 0)); // mismatch: WARNING, kept
    expect(titles(h.sent)).toEqual(["WARNING Day summary 2024-01-03"]);
  });

  it("reports a failed read and does not throw", async () => {
    const h = harness({
      readSummary: () => Promise.reject(new Error("mongo down")),
    });
    await expect(h.daily.tick(ist(16, 0))).resolves.toBeUndefined();
    expect(h.errors).toHaveLength(1);
    expect(h.sent).toEqual([]);
  });
});
