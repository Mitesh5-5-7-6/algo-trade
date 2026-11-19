import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TokenLookup } from "../engines/token-watch.js";
import {
  fyersTokenExpiry,
  renewWithRefreshToken,
} from "./fyers-token-renewal.js";
import { createMorningStart, type MorningStartDeps } from "./morning-start.js";

/** Epoch ms for 2026-11-19 at an IST wall-clock time. */
const at = (hh: number, mm: number): number =>
  Date.UTC(2026, 10, 19, hh, mm) - 19_800_000;

describe("a FYERS token's real expiry: 06:30 IST (FYERS v3 docs)", () => {
  it("is today's 06:30 before it, tomorrow's after it", () => {
    expect(fyersTokenExpiry(at(5, 0))).toBe(at(6, 30));
    expect(fyersTokenExpiry(at(10, 22))).toBe(at(6, 30) + 86_400_000);
    expect(fyersTokenExpiry(at(6, 30))).toBe(at(6, 30) + 86_400_000);
    // Last night's 22:00 login is dead at 06:30 — not at noon, as +14h said.
    expect(fyersTokenExpiry(at(22, 0) - 86_400_000)).toBe(at(6, 30));
  });
});

describe("renewing with the refresh token", () => {
  const request = {
    appId: "APP-200",
    appSecret: "secret",
    refreshToken: "refresh-1",
    pin: "1234",
  };

  it("posts the refresh token, the PIN and the app hash, and returns the new token", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const result = await renewWithRefreshToken({
      ...request,
      fetch: ((url: string, init?: RequestInit) => {
        seen.push({ url, body: JSON.parse(init?.body as string) });
        return Promise.resolve(
          new Response(
            JSON.stringify({ s: "ok", code: 200, access_token: "fresh" }),
            { status: 200 },
          ),
        );
      }) as typeof fetch,
    });
    expect(result).toEqual({ ok: true, accessToken: "fresh" });
    expect(seen).toEqual([
      {
        url: "https://api-t1.fyers.in/api/v3/validate-refresh-token",
        body: {
          grant_type: "refresh_token",
          appIdHash: createHash("sha256")
            .update("APP-200:secret")
            .digest("hex"),
          refresh_token: "refresh-1",
          pin: "1234",
        },
      },
    ]);
  });

  it("returns FYERS's own reason when refused, and never throws", async () => {
    const refused = await renewWithRefreshToken({
      ...request,
      fetch: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              s: "error",
              code: -501,
              message: "Please provide valid refresh token",
            }),
            { status: 400 },
          ),
        )),
    });
    expect(refused).toEqual({
      ok: false,
      reason:
        "FYERS refused the refresh (HTTP 400, code -501): Please provide valid refresh token",
    });
    const down = await renewWithRefreshToken({
      ...request,
      fetch: (() =>
        Promise.reject(new Error("socket hang up"))),
    });
    expect(down).toEqual({
      ok: false,
      reason: "FYERS did not answer: socket hang up",
    });
  });
});

function harness(over: Partial<MorningStartDeps> = {}) {
  let status: TokenLookup = "expired";
  const sent: { severity: string; title: string; body: string; key: string }[] =
    [];
  const renewals: number[] = [];
  let renewOutcome: string | null = "FYERS refused the refresh: no";
  const start = createMorningStart({
    isTradingDay: () => Promise.resolve(true),
    tokenStatus: () => Promise.resolve(status),
    renew: () => {
      renewals.push(1);
      if (renewOutcome === null) status = "present";
      return Promise.resolve(renewOutcome);
    },
    notify: (severity, title, body, key) => {
      sent.push({ severity, title, body, key });
    },
    onError: (error) => {
      throw error;
    },
    ...over,
  });
  /** Tick every minute from hh:mm to hh2:mm2. */
  const run = async (from: number, to: number) => {
    for (let t = from; t <= to; t += 60_000) await start.tick(t);
  };
  return {
    run,
    sent,
    renewals,
    setStatus: (s: TokenLookup) => {
      status = s;
    },
    setRenewOutcome: (o: string | null) => {
      renewOutcome = o;
    },
  };
}

describe("the morning start (2026-11-19)", () => {
  it("logs in automatically at 08:40 and sends no reminder", async () => {
    const h = harness();
    h.setRenewOutcome(null);
    await h.run(at(8, 30), at(9, 20));
    expect(h.renewals).toHaveLength(1);
    expect(h.sent.map((m) => [m.severity, m.title])).toEqual([
      ["INFO", "FYERS logged in automatically"],
    ]);
  });

  it("tries three times, then reminds at 08:45 and 09:05 with FYERS's reason", async () => {
    const h = harness();
    await h.run(at(8, 30), at(9, 20));
    expect(h.renewals).toHaveLength(3); // 08:40, 08:50, 09:00
    expect(h.sent.map((m) => [m.severity, m.title, m.key])).toEqual([
      [
        "WARNING",
        "Log in to FYERS before 09:15",
        "login-reminder:2026-11-19:1",
      ],
      [
        "WARNING",
        "Log in to FYERS before 09:15",
        "login-reminder:2026-11-19:2",
      ],
    ]);
    expect(h.sent[0]?.body).toMatch(
      /^Automatic login failed: FYERS refused the refresh: no\nOpen the dashboard/,
    );
  });

  it("stops the moment a token is there — logged in by hand at 08:47", async () => {
    const h = harness();
    await h.run(at(8, 30), at(8, 46));
    h.setStatus("present");
    await h.run(at(8, 47), at(9, 20));
    expect(h.renewals).toHaveLength(1);
    expect(h.sent).toHaveLength(1); // the 08:45 reminder only
  });

  it("says automatic login is off when it cannot run, and still reminds", async () => {
    const h = harness({
      renew: null,
      renewUnavailable: "FYERS_PIN is not set",
    });
    await h.run(at(8, 30), at(9, 20));
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]?.body).toMatch(
      /^Automatic login is off: FYERS_PIN is not set\./,
    );
  });

  it("does nothing on a holiday, with a valid token, or outside 08:40–09:15", async () => {
    const holiday = harness({ isTradingDay: () => Promise.resolve(false) });
    await holiday.run(at(8, 30), at(9, 20));
    expect([holiday.renewals.length, holiday.sent.length]).toEqual([0, 0]);

    const ready = harness();
    ready.setStatus("present");
    await ready.run(at(8, 30), at(9, 20));
    expect([ready.renewals.length, ready.sent.length]).toEqual([0, 0]);

    const late = harness();
    await late.run(at(9, 15), at(15, 30));
    expect([late.renewals.length, late.sent.length]).toEqual([0, 0]);
  });
});
