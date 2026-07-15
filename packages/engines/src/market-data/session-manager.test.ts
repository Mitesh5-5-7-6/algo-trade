import { describe, expect, it } from "vitest";
import {
  istDateKey,
  NSE_DEFAULT_SESSION,
  SessionManager,
  startOfDayIST,
} from "./session-manager.js";

/** Epoch ms for an IST wall-clock instant (month is 0-based). */
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const ist = (y: number, mo: number, d: number, h: number, mi: number): number =>
  Date.UTC(y, mo, d, h, mi) - IST_OFFSET_MS;

// 2026-01-05 is a Monday; -03 Sat, -04 Sun.
const MON = [2026, 0, 5] as const;

describe("SessionManager phase computation (plan/17 §6)", () => {
  it("maps IST wall-clock to closed / pre-open / open / closed across the day", () => {
    const phaseAt = (h: number, mi: number) =>
      new SessionManager().evaluate(ist(...MON, h, mi)).phase;
    expect(phaseAt(8, 30)).toBe("closed"); // before pre-open
    expect(phaseAt(9, 5)).toBe("pre-open"); // 09:00–09:15
    expect(phaseAt(9, 20)).toBe("open"); // 09:15–15:30
    expect(phaseAt(15, 29)).toBe("open");
    expect(phaseAt(15, 45)).toBe("closed"); // after close
  });

  it("is closed all day on weekends", () => {
    const sat = new SessionManager().evaluate(ist(2026, 0, 3, 11, 0));
    const sun = new SessionManager().evaluate(ist(2026, 0, 4, 11, 0));
    expect(sat.phase).toBe("closed");
    expect(sun.phase).toBe("closed");
  });

  it("is closed all day on a configured holiday", () => {
    const manager = new SessionManager({
      ...NSE_DEFAULT_SESSION,
      holidays: ["2026-01-05"],
    });
    expect(manager.evaluate(ist(...MON, 11, 0)).phase).toBe("closed");
  });
});

describe("SessionManager transitions (plan/17 §6)", () => {
  it("first evaluation reports a phase change but no market transition", () => {
    const e = new SessionManager().evaluate(ist(...MON, 9, 20));
    expect(e.phase).toBe("open");
    expect(e.phaseChanged).toBe(true);
    expect(e.marketOpened).toBe(false); // honest: we don't know the prior state
    expect(e.marketClosed).toBe(false);
  });

  it("emits marketOpened crossing into open, marketClosed crossing out", () => {
    const m = new SessionManager();
    m.evaluate(ist(...MON, 8, 30)); // closed (first eval)
    const preOpen = m.evaluate(ist(...MON, 9, 5));
    expect(preOpen.marketOpened).toBe(false);

    const open = m.evaluate(ist(...MON, 9, 16));
    expect(open.marketOpened).toBe(true);
    expect(open.marketClosed).toBe(false);

    const stillOpen = m.evaluate(ist(...MON, 12, 0));
    expect(stillOpen.phaseChanged).toBe(false);
    expect(stillOpen.marketOpened).toBe(false);

    const closed = m.evaluate(ist(...MON, 15, 45));
    expect(closed.marketClosed).toBe(true);
    expect(closed.marketOpened).toBe(false);
  });

  it("rejects a misconfigured session window", () => {
    expect(
      () =>
        new SessionManager({
          ...NSE_DEFAULT_SESSION,
          open: "15:30",
          close: "09:15",
        }),
    ).toThrow();
  });
});

describe("istDateKey", () => {
  it("returns the IST trading date, not the UTC date", () => {
    // 2026-01-05 20:00 UTC = 2026-01-06 01:30 IST → next day in IST.
    expect(istDateKey(Date.UTC(2026, 0, 5, 20, 0))).toBe("2026-01-06");
    expect(istDateKey(ist(...MON, 9, 20))).toBe("2026-01-05");
  });
});

describe("startOfDayIST", () => {
  it("returns IST midnight of the instant's trading date, in epoch ms", () => {
    // Any instant during Monday's IST day maps to Mon 00:00 IST.
    expect(startOfDayIST(ist(...MON, 9, 20))).toBe(ist(...MON, 0, 0));
    expect(startOfDayIST(ist(...MON, 23, 59))).toBe(ist(...MON, 0, 0));
    // 20:00 UTC Mon is already Tuesday 01:30 IST → Tuesday's midnight.
    expect(startOfDayIST(Date.UTC(2026, 0, 5, 20, 0))).toBe(
      ist(2026, 0, 6, 0, 0),
    );
  });

  it("agrees with istDateKey about which day an instant belongs to", () => {
    const around = Date.UTC(2026, 0, 5, 18, 30); // exactly IST midnight
    for (const now of [around - 1, around, around + 1]) {
      expect(istDateKey(startOfDayIST(now))).toBe(istDateKey(now));
    }
  });
});
