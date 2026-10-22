import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DocumentsRepository,
  ensureIndexes,
  type MongoConnection,
} from "@neelkanth/db";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "../test-support/infra.js";
import { makeDocument, type KnowledgeDocument } from "./document.js";
import { filterOf, searchKnowledge } from "./search.js";

/** Task 10.4 (design D4, D5): search by facet and by text, never past asOf. */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;

const src = {
  collection: "research_reports",
  id: "x",
  version: 1,
  fingerprint: "f".repeat(64),
};
const trade = (
  date: string,
  strategy: string,
  outcome: string,
  regime: string,
  words = "",
): KnowledgeDocument =>
  makeDocument({
    docId: `TRADE|${date}|${strategy}`,
    kind: "TRADE",
    source: src,
    subject: { fromDate: date, toDate: date },
    facets: {
      symbols: ["NSE:NIFTY50-INDEX"],
      patterns: ["ORB_BREAKOUT"],
      strategies: [strategy],
      regimes: [regime],
      outcome,
      n: 1,
    },
    title: `${strategy} on NSE:NIFTY50-INDEX, ${date} — ${outcome}`,
    text: `On ${date} ${strategy} traded after ORB_BREAKOUT in a ${regime} regime${words}; n = 1: ${outcome}, net 1.`,
  });
const DOCS: KnowledgeDocument[] = [
  trade(
    "2026-03-02",
    "ORB",
    "LOSS",
    "BEARISH",
    ", a gap down below the opening range",
  ),
  trade("2026-03-04", "ORB", "WIN", "BULLISH"),
  trade("2026-03-05", "RSI", "LOSS", "BEARISH"),
  trade("2026-03-09", "ORB", "LOSS", "BEARISH", ", a gap down again"),
  makeDocument({
    docId: "WINDOW|WEEK|2026-W10",
    kind: "WINDOW",
    source: src,
    subject: { fromDate: "2026-03-02", toDate: "2026-03-08" },
    facets: {
      symbols: ["NSE:NIFTY50-INDEX"],
      patterns: ["ORB_BREAKOUT"],
      strategies: ["ORB", "RSI"],
      regimes: ["BEARISH"],
      n: 3,
      period: "WEEK",
    },
    title: "WEEK 2026-W10",
    text: "WEEK 2026-W10 (2026-03-02 .. 2026-03-08): ORB failed repeatedly on ORB_BREAKOUT, n = 2, net -10.",
  }),
  makeDocument({
    docId: "DETECTOR|ORB_BREAKOUT@1.0.0",
    kind: "DETECTOR",
    source: { ...src, collection: "patterns", version: null },
    subject: { fromDate: "0001-01-01", toDate: "0001-01-01" },
    facets: {
      symbols: [],
      patterns: ["ORB_BREAKOUT"],
      strategies: [],
      regimes: [],
    },
    title: "ORB_BREAKOUT 1.0.0",
    text: "ORB_BREAKOUT version 1.0.0: the first N minutes of the session form an opening range.",
  }),
];

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_knowledge_search",
    "knowledge search",
  );
  if (!probe.reachable) return;
  connection = probe.connection;
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);
  await new DocumentsRepository(connection.db).replaceMany(DOCS);
}, 120_000);

afterAll(async () => {
  await closeProbe(probe);
});

const ids = (hits: { docId: string }[]) => hits.map((h) => h.docId);
const skipUnlessMongo = () => probe?.reachable !== true;

describe("structured search (10.4, D4)", () => {
  it("filters by kind, strategy, regime and outcome, newest first", async (ctx) => {
    if (skipUnlessMongo()) return ctx.skip();
    expect(
      ids(
        await searchKnowledge(connection.db, {
          kinds: ["TRADE"],
          strategies: ["ORB"],
          outcome: "LOSS",
        }),
      ),
    ).toEqual(["TRADE|2026-03-09|ORB", "TRADE|2026-03-02|ORB"]);
    expect(
      ids(
        await searchKnowledge(connection.db, {
          kinds: ["TRADE"],
          regimes: ["BULLISH"],
        }),
      ),
    ).toEqual(["TRADE|2026-03-04|ORB"]);
  });

  it("finds research whose subject overlaps a date range", async (ctx) => {
    if (skipUnlessMongo()) return ctx.skip();
    const hits = await searchKnowledge(connection.db, {
      fromDate: "2026-03-05",
      toDate: "2026-03-06",
    });
    expect(ids(hits).sort()).toEqual([
      "TRADE|2026-03-05|RSI",
      "WINDOW|WEEK|2026-W10",
    ]);
  });
});

describe("text search (10.4, D4)", () => {
  it("ranks by relevance, reproducibly", async (ctx) => {
    if (skipUnlessMongo()) return ctx.skip();
    const a = await searchKnowledge(connection.db, {
      text: "gap down opening range",
    });
    expect(ids(a)[0]).toBe("TRADE|2026-03-02|ORB"); // matches all three terms
    expect(a.every((h) => typeof h.score === "number")).toBe(true);
    expect(
      ids(
        await searchKnowledge(connection.db, {
          text: "gap down opening range",
        }),
      ),
    ).toEqual(ids(a));
  });

  it("combines with facets", async (ctx) => {
    if (skipUnlessMongo()) return ctx.skip();
    expect(
      ids(
        await searchKnowledge(connection.db, {
          text: "opening range",
          kinds: ["DETECTOR"],
        }),
      ),
    ).toEqual(["DETECTOR|ORB_BREAKOUT@1.0.0"]);
  });
});

describe("nothing from after asOf (10.4, D5)", () => {
  it("excludes research about later periods — and keeps definitions, which have none", async (ctx) => {
    if (skipUnlessMongo()) return ctx.skip();
    const hits = await searchKnowledge(connection.db, {
      asOf: "2026-03-04",
      limit: 50,
    });
    expect(ids(hits).sort()).toEqual([
      "DETECTOR|ORB_BREAKOUT@1.0.0",
      "TRADE|2026-03-02|ORB",
      "TRADE|2026-03-04|ORB",
    ]);
    // The week ending 03-08 was not over on 03-04.
    expect(ids(hits)).not.toContain("WINDOW|WEEK|2026-W10");
    // And text search obeys it too.
    expect(
      ids(
        await searchKnowledge(connection.db, {
          text: "gap down",
          asOf: "2026-03-04",
        }),
      ),
    ).toEqual(["TRADE|2026-03-02|ORB"]);
  });

  it("caps the result size", async (ctx) => {
    if (skipUnlessMongo()) return ctx.skip();
    expect(await searchKnowledge(connection.db, { limit: 2 })).toHaveLength(2);
    expect(filterOf({ asOf: "2026-03-04", fromDate: "2026-03-01" })).toEqual({
      "subject.toDate": { $gte: "2026-03-01", $lte: "2026-03-04" },
    });
  });
});
