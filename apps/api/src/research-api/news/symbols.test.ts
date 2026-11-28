import { describe, expect, it } from "vitest";
import { ALL_HEAVYWEIGHTS } from "@neelkanth/core";
import { HEAVYWEIGHTS, symbolsIn, topicsIn } from "./symbols.js";

// The news names the same stocks a signal counts (PLAN.md 14.25): a list
// changed in one place and not the other would read news no lesson uses.
describe("the news reads the core heavyweights", () => {
  it("names exactly the stocks in INDEX_HEAVYWEIGHTS", () => {
    expect(HEAVYWEIGHTS.map((h) => h.symbol).sort()).toEqual(
      [...ALL_HEAVYWEIGHTS].sort(),
    );
  });
});

describe("symbolsIn — the heavyweights a title names", () => {
  it("finds each heavyweight by its name, real titles from the feeds included", () => {
    const cases: [string, string[]][] = [
      [
        "HDFC Bank Share Price Highlights: HDFC Bank Stock Price History",
        ["NSE:HDFCBANK-EQ"],
      ],
      [
        "ICICI Bank Share Price Highlights: ICICI Bank Stock Price History",
        ["NSE:ICICIBANK-EQ"],
      ],
      [
        "RIL Share Price Live Updates: RIL Stock Price History",
        ["NSE:RELIANCE-EQ"],
      ],
      ["Reliance Industries to demerge new energy arm", ["NSE:RELIANCE-EQ"]],
      ["Reliance Jio raises tariffs by 10%", ["NSE:RELIANCE-EQ"]],
      [
        "Infosys Share Price Highlights: Infosys Stock Price History",
        ["NSE:INFY-EQ"],
      ],
      ["INFOSYS WINS $1 BN DEAL", ["NSE:INFY-EQ"]],
      [
        "Bharti Airtel Share Price Highlights: Bharti Airtel Stock Price History",
        ["NSE:BHARTIARTL-EQ"],
      ],
      ["Airtel's ARPU rises to Rs 250", ["NSE:BHARTIARTL-EQ"]],
      ["L&T Share Price Highlights: L&T Stock Price History", ["NSE:LT-EQ"]],
      ["Larsen & Toubro bags mega order", ["NSE:LT-EQ"]],
      ["ITC Share Price Highlights: ITC Stock Price History", ["NSE:ITC-EQ"]],
      ["TCS Share Price Highlights: TCS Stock Price History", ["NSE:TCS-EQ"]],
      ["TCS on Thursday reported a 5% rise in net profit", ["NSE:TCS-EQ"]],
      [
        "Axis Bank Share Price Highlights: Axis Bank Stock Price History",
        ["NSE:AXISBANK-EQ"],
      ],
      ["SBI Share Price Highlights: SBI Stock Price History", ["NSE:SBIN-EQ"]],
      ["State Bank of India cuts lending rates", ["NSE:SBIN-EQ"]],
      [
        "Kotak Bank Share Price Highlights: Kotak Bank Stock Price History",
        ["NSE:KOTAKBANK-EQ"],
      ],
      ["Kotak Mahindra Bank gets RBI nod", ["NSE:KOTAKBANK-EQ"]],
      [
        "HDFC Bank, ICICI Bank and SBI lead the Bank Nifty higher",
        ["NSE:HDFCBANK-EQ", "NSE:ICICIBANK-EQ", "NSE:SBIN-EQ"],
      ],
      ["SBI Life slips while SBI gains 2%", ["NSE:SBIN-EQ"]],
    ];
    for (const [title, symbols] of cases)
      expect(symbolsIn(title), title).toEqual(symbols);
  });

  it("does not take a different company for a heavyweight", () => {
    const none = [
      // Real titles from the feeds, 2026-11-28.
      "SBI Life Share Price Highlights: SBI Life Stock Price History",
      "HDFC Life Share Price Highlights: HDFC Life Stock Price History",
      "Jio Financial Services Share Price Highlights: Jio Financial Services Stock Price History",
      "LTIMindtree Share Price Highlights: LTIMindtree Stock Price History",
      "Best 3 stocks to buy: Manappuram Finance, BEL, SBI Life by Sumeet Bagadia | Targets, stoploss, Nifty, Bank Nifty outlook",
      "Capital market industry hopes for relief in capital gains taxation in Budget 2027-28: Axis Capital MD",
      "Kishanbagh businessman loses Rs 4.5 Lakh in fake HDFC credit card limit offer - Hyderabad Mail",
      // Other group companies and lookalikes.
      "HDFC AMC net profit rises 20%",
      "HDFC shares rise",
      "SBI Card adds 1 million cards",
      "SBI Cards and Payment Services Q2 results",
      "SBI Mutual Fund launches new NFO",
      "Reliance Power shares hit upper circuit",
      "Reliance Infrastructure wins arbitration",
      "ICICI Prudential Life Q2 results",
      "ICICI Lombard premium grows",
      "L&T Finance raises Rs 1,000 crore",
      "L&T Technology Services wins deal",
      "ITC Hotels shares fall on debut",
      "Airtel Africa revenue grows",
      "TCS on foreign remittances to rise from April",
      "New TCS rates for overseas tour packages",
      "Kotak Securities recommends three stocks",
      "Tata Motors and Tata Steel lead gains",
      "itc is lower case",
      "APRIL auto sales",
      "Bharti Hexacom shares surge",
    ];
    for (const title of none) expect(symbolsIn(title), title).toEqual([]);
  });

  it("lists the eleven heavyweights, each with a quoted Google News name", () => {
    expect(HEAVYWEIGHTS.map((h) => h.symbol)).toEqual([
      "NSE:HDFCBANK-EQ",
      "NSE:ICICIBANK-EQ",
      "NSE:RELIANCE-EQ",
      "NSE:INFY-EQ",
      "NSE:BHARTIARTL-EQ",
      "NSE:LT-EQ",
      "NSE:ITC-EQ",
      "NSE:TCS-EQ",
      "NSE:AXISBANK-EQ",
      "NSE:SBIN-EQ",
      "NSE:KOTAKBANK-EQ",
    ]);
    // Plain "HDFC" is never an alias: it also names HDFC Life and HDFC AMC.
    for (const h of HEAVYWEIGHTS) expect(h.names).not.toContain("HDFC");
  });
});

describe("topicsIn — the market topics a title touches", () => {
  it("tags real titles from the feeds", () => {
    const cases: [string, string[]][] = [
      ["Bond market to stay cautious ahead of RBI policy: Equirus", ["RBI"]],
      [
        "Gold pares gains as Fed hike risks linger, eyes first weekly rise in three weeks",
        ["FED"],
      ],
      [
        "Gold pares gains as Fed-hike risks linger, eyes first weekly rise in three weeks",
        ["FED"],
      ],
      [
        "Nasdaq jumps 2%, Dow gains 600 pts as US stocks log weekly gains: Stock Market Live Updates",
        ["US_MARKETS"],
      ],
      [
        "Wall St Week Ahead: Volatile stock market confronts jobs data, rate view as next tests",
        ["US_MARKETS"],
      ],
      ["OPEC+ set to keep oil production targets steady: Report", ["CRUDE"]],
      [
        "From war premium to demand concerns: What is driving the sharp fall in crude oil prices?",
        ["CRUDE"],
      ],
      ["India bonds slump as oil spike adds to RBI hike bets", ["RBI"]],
      [
        "Capital market industry hopes for relief in capital gains taxation in Budget 2027-28: Axis Capital MD",
        ["BUDGET"],
      ],
      [
        "Sebi allows FPIs to trade in physically settled non-agri commodity derivatives",
        ["FII"],
      ],
      [
        "Why is RBI moving gold back to India? What Russia's frozen reserves and 1991 crisis reveal",
        ["RBI"],
      ],
      ["TCS Q2 results: net profit rises 5%", ["RESULTS"]],
      ["Foreign investors pull out Rs 10,000 crore in November", ["FII"]],
      ["Union Budget 2026: what the markets want", ["BUDGET"]],
      [
        "FOMC minutes signal a December pause; S&P 500 rises",
        ["FED", "US_MARKETS"],
      ],
    ];
    for (const [title, topics] of cases)
      expect(topicsIn(title), title).toEqual(topics);
  });

  it("leaves untouched what matches nothing, and is not fooled by lookalikes", () => {
    for (const title of [
      "Concurrent Gainers: 9 stocks that gain for 5 days in a row",
      "FedEx shares jump",
      "Budget smartphones under Rs 15,000",
      "Dowry case adjourned",
      "Crudely put, the rally is over",
    ])
      expect(topicsIn(title), title).toEqual([]);
  });
});
