import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  changesByDate,
  fetchOvernightMoves,
  nextIndianWeekday,
  parseYahooChart,
  toOvernightMoves,
  yahooChartUrl,
} from "./overnight.js";

/** Yahoo's real answers for range=5d, fetched 2026-11-28 (a Saturday in India). */
const chart = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
const GSPC = chart("yahoo-gspc-5d.json");
const IXIC = chart("yahoo-ixic-5d.json");
/** After Friday 2026-11-27's early close (13:00 New York = 18:00 UTC). */
const SATURDAY = Date.parse("2026-11-28T10:00:00Z");

describe("nextIndianWeekday", () => {
  it("maps a US session to the Indian weekday that opens after it", () => {
    expect(nextIndianWeekday("2026-11-27")).toBe("2026-11-30"); // Fri -> Mon
    expect(nextIndianWeekday("2026-11-23")).toBe("2026-11-24"); // Mon -> Tue
    expect(nextIndianWeekday("2026-11-25")).toBe("2026-11-26"); // Wed -> Thu
    expect(nextIndianWeekday("2026-12-31")).toBe("2027-01-01"); // over the year
    // Holidays are not consulted: Thanksgiving Thursday had no session, so
    // nothing maps to Friday 2026-11-27 from it.
  });
});

describe("parseYahooChart", () => {
  it("reads the completed daily closes by New York date", () => {
    expect(parseYahooChart(GSPC, SATURDAY)).toEqual([
      { usDate: "2026-11-20", close: 6910.39013671875 },
      { usDate: "2026-11-23", close: 7237.169921875 },
      { usDate: "2026-11-24", close: 7201.08984375 },
      { usDate: "2026-11-25", close: 7182.77978515625 },
      { usDate: "2026-11-27", close: 7297.490234375 },
    ]);
  });

  it("leaves out the session still trading — its close is only a price", () => {
    const duringFriday = Date.parse("2026-11-27T16:00:00Z"); // 11:00 New York
    expect(parseYahooChart(GSPC, duringFriday).map((c) => c.usDate)).toEqual([
      "2026-11-20",
      "2026-11-23",
      "2026-11-24",
      "2026-11-25",
    ]);
  });

  it("skips a missing close and refuses an answer of the wrong shape", () => {
    const withGap = {
      chart: {
        result: [
          {
            timestamp: [1795185000, 1795444200],
            indicators: { quote: [{ close: [null, 7237.17] }] },
          },
        ],
      },
    };
    expect(parseYahooChart(withGap, SATURDAY)).toEqual([
      { usDate: "2026-11-23", close: 7237.17 },
    ]);
    expect(() =>
      parseYahooChart({ chart: { result: null } }, SATURDAY),
    ).toThrow();
  });
});

describe("changesByDate and toOvernightMoves", () => {
  it("is close to close, in percent, from the second close on", () => {
    const changes = changesByDate([
      { usDate: "2026-11-20", close: 100 },
      { usDate: "2026-11-23", close: 101.5 },
      { usDate: "2026-11-24", close: 100.485 },
    ]);
    expect([...changes]).toEqual([
      ["2026-11-23", 1.5],
      ["2026-11-24", -1],
    ]);
  });

  it("puts Friday's US close on Monday in India, both indices together", () => {
    const moves = toOvernightMoves(
      parseYahooChart(GSPC, SATURDAY),
      parseYahooChart(IXIC, SATURDAY),
    );
    expect(moves.map((m) => [m.usDate, m.date])).toEqual([
      ["2026-11-23", "2026-11-24"],
      ["2026-11-24", "2026-11-25"],
      ["2026-11-25", "2026-11-26"],
      ["2026-11-27", "2026-11-30"],
    ]);
    const monday = moves.at(-1);
    expect(monday).toEqual({
      date: "2026-11-30",
      usDate: "2026-11-27",
      spxChangePct: 1.597, // 7182.78 -> 7297.49, as Yahoo's own meta says
      ndxChangePct: 2.3052, // 23585.80 -> 24129.50
      source: "yahoo-chart",
    });
  });

  it("needs both indices for a date", () => {
    const spx = [
      { usDate: "2026-11-24", close: 100 },
      { usDate: "2026-11-25", close: 101 },
    ];
    expect(toOvernightMoves(spx, spx.slice(0, 1))).toEqual([]);
  });
});

describe("fetchOvernightMoves", () => {
  it("asks for both charts by range and joins them", async () => {
    const asked: string[] = [];
    const moves = await fetchOvernightMoves({
      fetchText: (url) => {
        asked.push(url);
        return Promise.resolve(
          JSON.stringify(url.includes("%5EGSPC") ? GSPC : IXIC),
        );
      },
      range: "5d",
      now: SATURDAY,
    });
    expect(asked).toEqual([
      yahooChartUrl("^GSPC", "5d"),
      yahooChartUrl("^IXIC", "5d"),
    ]);
    expect(asked[0]).toBe(
      "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=5d&interval=1d",
    );
    expect(moves).toHaveLength(4);
  });
});
