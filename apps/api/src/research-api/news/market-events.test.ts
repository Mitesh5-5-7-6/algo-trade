import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MarketEvent } from "@neelkanth/core";
import { loadMarketEvents, seedMarketEvents } from "./market-events.js";
import { nextIndianWeekday } from "./overnight.js";

/** The calendar file as written — the loader keeps less than this. */
const RAW = JSON.parse(
  readFileSync(new URL("./market-events.json", import.meta.url), "utf8"),
) as {
  events: {
    date: string;
    kind: string;
    title: string;
    source: string;
    evidence: string;
  }[];
};

describe("the event calendar (market-events.json)", () => {
  const events = loadMarketEvents();

  it("loads every event, each with the page its date was read on", () => {
    expect(events.length).toBe(RAW.events.length);
    for (const e of events) {
      expect(e.source, e.title).toMatch(/^https:\/\//);
      expect(e.date >= "2025-09-01" && e.date <= "2026-12-31", e.title).toBe(
        true,
      );
    }
    for (const e of RAW.events)
      expect(e.evidence.length, e.title).toBeGreaterThan(0);
  });

  it("reads RBI dates from rbi.org.in and FOMC dates from the Federal Reserve's calendar", () => {
    for (const e of events.filter((x) => x.kind === "RBI_POLICY"))
      expect(e.source, e.title).toMatch(/^https:\/\/www\.rbi\.org\.in\//);
    for (const e of events.filter((x) => x.kind === "FOMC"))
      expect(e.source).toBe(
        "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
      );
    expect(
      events.filter((x) => x.kind === "RBI_POLICY").map((e) => e.date),
    ).toEqual([
      "2025-10-01",
      "2025-12-05",
      "2026-02-06",
      "2026-04-08",
      "2026-06-05",
      "2026-08-05",
      "2026-10-07",
      "2026-12-04",
    ]);
    expect(
      events.filter((x) => x.kind === "UNION_BUDGET").map((e) => e.date),
    ).toEqual(["2026-02-01"]);
  });

  it("stores an FOMC decision on the Indian session after it, and says so in the title", () => {
    const fomc = events.filter((x) => x.kind === "FOMC");
    expect(fomc).toHaveLength(11);
    for (const e of fomc) {
      const us = /decision of \w{3} (\d{4}-\d{2}-\d{2}), 14:00 New York/.exec(
        e.title,
      )?.[1];
      expect(us, e.title).toBeDefined();
      expect(e.title).toMatch(/the Indian session after it$/);
      expect(e.date, e.title).toBe(nextIndianWeekday(us ?? ""));
      // Each decision day named is the Wednesday it was.
      expect(new Date(`${us ?? ""}T00:00:00Z`).getUTCDay(), e.title).toBe(3);
    }
  });

  it("is loaded idempotently: a second load adds nothing", async () => {
    const kept = new Map<string, MarketEvent>();
    const upsert = (e: MarketEvent) => {
      const key = `${e.date}|${e.kind}|${e.title}`;
      if (kept.has(key)) return Promise.resolve(false);
      kept.set(key, e);
      return Promise.resolve(true);
    };
    expect(await seedMarketEvents(events, upsert)).toBe(events.length);
    expect(await seedMarketEvents(events, upsert)).toBe(0);
  });
});
