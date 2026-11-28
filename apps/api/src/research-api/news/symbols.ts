/**
 * Which index heavyweights and which market topics a headline names — by
 * keyword, on the title alone. Kept local to the news module for now; the
 * trading side keeps its own heavyweight list and the two are to be unified.
 *
 * A name is matched whole-word. Names that a different listed company shares
 * a prefix with are excluded first: "SBI Life" and "SBI Card" are not State
 * Bank of India, "HDFC Life" is not HDFC Bank (so plain "HDFC" is no alias),
 * "Jio Financial" and "Reliance Power" are not Reliance Industries. Short
 * acronyms (RIL, ITC, TCS, SBI, L&T) match only in capitals.
 */

export interface Heavyweight {
  symbol: string;
  /** The name a Google News query asks for, in quotes. */
  name: string;
  /** Case-insensitive whole-word names. */
  names: readonly string[];
  /** Case-sensitive whole-word acronyms. */
  acronyms: readonly string[];
  /** Phrases removed before matching, case-insensitive — other companies. */
  excludes: readonly string[];
}

export const HEAVYWEIGHTS: readonly Heavyweight[] = [
  {
    symbol: "NSE:HDFCBANK-EQ",
    name: "HDFC Bank",
    names: ["HDFC Bank", "HDFCBANK"],
    acronyms: [],
    excludes: [],
  },
  {
    symbol: "NSE:ICICIBANK-EQ",
    name: "ICICI Bank",
    names: ["ICICI Bank", "ICICIBANK"],
    acronyms: [],
    excludes: [],
  },
  {
    symbol: "NSE:RELIANCE-EQ",
    name: "Reliance Industries",
    names: [
      "Reliance Industries",
      "Reliance Jio",
      "Jio Platforms",
      "Reliance Retail",
    ],
    acronyms: ["RIL"],
    excludes: ["Jio Financial"],
  },
  {
    symbol: "NSE:INFY-EQ",
    name: "Infosys",
    names: ["Infosys"],
    acronyms: ["INFY"],
    excludes: [],
  },
  {
    symbol: "NSE:BHARTIARTL-EQ",
    name: "Bharti Airtel",
    names: ["Bharti Airtel", "Airtel", "BHARTIARTL"],
    acronyms: [],
    excludes: ["Airtel Africa"],
  },
  {
    symbol: "NSE:LT-EQ",
    name: "Larsen & Toubro",
    names: ["Larsen & Toubro", "Larsen and Toubro", "Larsen"],
    acronyms: ["L&T"],
    excludes: [
      "L&T Finance",
      "L&T Technology",
      "L&T Tech",
      "L&T Infotech",
      "Larsen & Toubro Infotech",
      "L&T Mutual Fund",
    ],
  },
  {
    symbol: "NSE:ITC-EQ",
    name: "ITC Ltd",
    names: [],
    acronyms: ["ITC"],
    excludes: ["ITC Hotels"],
  },
  {
    symbol: "NSE:TCS-EQ",
    name: "Tata Consultancy Services",
    names: ["Tata Consultancy Services", "Tata Consultancy"],
    acronyms: ["TCS"],
    // "TCS" is also tax collected at source. Exclusions are substrings, so
    // "TCS rate" covers "TCS rates" and "TCS on remittance" the plural.
    excludes: [
      "tax collected at source",
      "TCS on foreign",
      "TCS on overseas",
      "TCS on remittance",
      "TCS on LRS",
      "TCS on sale",
      "TCS rate",
      "TCS rule",
      "TCS provision",
      "TCS credit",
      "TCS refund",
      "TDS and TCS",
      "TDS/TCS",
    ],
  },
  {
    symbol: "NSE:AXISBANK-EQ",
    name: "Axis Bank",
    names: ["Axis Bank", "AXISBANK"],
    acronyms: [],
    excludes: [],
  },
  {
    symbol: "NSE:SBIN-EQ",
    name: "State Bank of India",
    names: ["State Bank of India", "SBIN"],
    acronyms: ["SBI"],
    excludes: [
      "SBI Life",
      "SBI Card",
      "SBI Funds",
      "SBI Mutual Fund",
      "SBI MF",
      "SBI General",
      "SBI Securities",
      "SBI Capital",
      "SBI Caps",
      "SBICAP",
    ],
  },
  {
    symbol: "NSE:KOTAKBANK-EQ",
    name: "Kotak Mahindra Bank",
    names: ["Kotak Mahindra Bank", "Kotak Bank", "KOTAKBANK"],
    acronyms: [],
    excludes: [],
  },
];

export const HEAVYWEIGHT_SYMBOLS: ReadonlySet<string> = new Set(
  HEAVYWEIGHTS.map((h) => h.symbol),
);

const escape = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A whole-word pattern. `\b` cannot bound a name that starts or ends in a
 * symbol ("L&T"), so the edges are "not a letter or digit" instead.
 */
const word = (text: string, flags: string): RegExp =>
  new RegExp(`(?<![A-Za-z0-9])${escape(text)}(?![A-Za-z0-9])`, flags);

const COMPILED = HEAVYWEIGHTS.map((h) => ({
  symbol: h.symbol,
  patterns: [
    ...h.names.map((n) => word(n, "i")),
    ...h.acronyms.map((a) => word(a, "")),
  ],
  // Exclusions match a name followed by more words, e.g. "TCS on": case-
  // insensitive, but an acronym's own case is kept by the case-sensitive
  // alias test that runs after them.
  excludes: h.excludes.map((e) => new RegExp(escape(e), "gi")),
}));

/** The heavyweights a title names, in the list's order. */
export function symbolsIn(title: string): string[] {
  const out: string[] = [];
  for (const h of COMPILED) {
    let text = title;
    for (const e of h.excludes) text = text.replace(e, " ");
    if (h.patterns.some((p) => p.test(text))) out.push(h.symbol);
  }
  return out;
}

/** The keyword topics, each by the words that mean it in a market headline. */
const TOPICS: readonly { topic: string; patterns: readonly RegExp[] }[] = [
  {
    topic: "RBI",
    patterns: [
      /\bRBI\b/,
      /\bReserve Bank\b/i,
      /\brepo rate\b/i,
      /\bMPC\b/,
      /\bmonetary policy committee\b/i,
    ],
  },
  {
    topic: "FED",
    patterns: [
      /\bFed\b/,
      /\bFederal Reserve\b/i,
      /\bFOMC\b/,
      /\bPowell\b/,
      /\bUS rate (cut|hike)s?\b/i,
    ],
  },
  {
    topic: "BUDGET",
    patterns: [
      /\bUnion Budget\b/i,
      /\bBudget\s*20\d\d\b/i,
      /\bbudget day\b/i,
      /\bfiscal deficit\b/i,
      /\bSitharaman\b/i,
    ],
  },
  {
    topic: "RESULTS",
    patterns: [
      /\bQ[1-4]\s*(FY\s*\d{2,4}\s*)?(results?|earnings|profit|net profit|loss|revenue|numbers|update)\b/i,
      /\b(quarterly|q[1-4]) (results?|earnings)\b/i,
      /\bnet profit\b/i,
      /\bearnings\b/i,
      /\bresults?\b/i,
    ],
  },
  {
    topic: "US_MARKETS",
    patterns: [
      /\bWall St(reet|\.)?(?![A-Za-z])/i,
      /\bS&P\s?500\b/i,
      /\bNasdaq\b/i,
      /\bDow\b/,
      /\bDow Jones\b/i,
      /\bUS (stocks?|markets?|equities|shares)\b/i,
    ],
  },
  {
    topic: "CRUDE",
    patterns: [
      /\bcrude\b/i,
      /\boil prices?\b/i,
      /\bBrent\b/,
      /\bWTI\b/,
      /\bOPEC\b/i,
    ],
  },
  {
    topic: "FII",
    patterns: [
      /\bFIIs?\b/,
      /\bFPIs?\b/,
      /\bforeign (institutional |portfolio )?investors?\b/i,
      /\bforeign (fund )?(outflows?|inflows?|selling|buying)\b/i,
    ],
  },
];

export const TOPIC_NAMES: readonly string[] = TOPICS.map((t) => t.topic);

/** The topics a title touches, in a fixed order. */
export function topicsIn(title: string): string[] {
  return TOPICS.filter((t) => t.patterns.some((p) => p.test(title))).map(
    (t) => t.topic,
  );
}
