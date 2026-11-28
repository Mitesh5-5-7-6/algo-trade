import { readFileSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  COLLECTIONS,
  DayContextsRepository,
  type MongoConnection,
} from "@neelkanth/db";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "../../test-support/infra.js";
import type { ResearchAi } from "../environment.js";
import type { ChatFn } from "./morning-read.js";
import { NewsService } from "./service.js";

/**
 * The pipeline end to end on a scratch database, the network replaced by the
 * real feed and chart fixtures and the model by a fake: collected twice,
 * nothing duplicated; the calendar loaded twice, nothing duplicated; the
 * morning read kept and the day context built from all of it.
 */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/** Each URL answered from the fixture of its site. */
function fakeFetch(url: string): Promise<string> {
  if (url.includes("1977021501"))
    return Promise.resolve(fixture("et-markets.xml"));
  if (url.includes("2146842")) return Promise.resolve(fixture("et-stocks.xml"));
  if (url.includes("livemint")) return Promise.resolve(fixture("livemint.xml"));
  if (url.includes("rbi.org.in")) return Promise.resolve(fixture("rbi.xml"));
  if (url.includes("news.google.com"))
    return Promise.resolve(fixture("gnews.xml"));
  if (url.includes("%5EGSPC"))
    return Promise.resolve(fixture("yahoo-gspc-5d.json"));
  if (url.includes("%5EIXIC"))
    return Promise.resolve(fixture("yahoo-ixic-5d.json"));
  return Promise.reject(new Error(`unexpected ${url}`));
}

/** Monday 2026-11-30, 08:40 IST: the morning read's slot. */
const NOW = Date.parse("2026-11-30T08:40:00+05:30");
const AI: ResearchAi = {
  ai: { provider: "gemini", model: "gemini-test", apiKey: "k" },
  note: null,
  forbidden: [],
};

const service = (chat?: ChatFn, ai: ResearchAi = AI) => {
  const errors: unknown[] = [];
  const s = new NewsService({
    db: connection.db,
    now: () => NOW,
    ai,
    onError: (e) => errors.push(e),
    fetchText: fakeFetch,
    sleep: () => Promise.resolve(),
    ...(chat === undefined ? {} : { chat }),
  });
  return { s, errors };
};

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_news_service",
    "apps/api/src/research-api/news/service.integration.test.ts",
  );
  if (!probe.reachable) return;
  connection = probe.connection;
  await connection.db.dropDatabase();
});
beforeEach(async (ctx) => {
  if (probe?.reachable !== true) {
    ctx.skip();
    return;
  }
  for (const name of [
    COLLECTIONS.newsItems,
    COLLECTIONS.marketEvents,
    COLLECTIONS.overnightMoves,
    COLLECTIONS.morningReads,
    COLLECTIONS.dayContexts,
  ])
    await connection.db.collection(name).deleteMany({});
});
afterAll(async () => {
  await closeProbe(probe);
});

describe("NewsService on a scratch database", () => {
  it("loads the calendar once however often it starts", async () => {
    const { s } = service();
    const first = await s.prepare();
    expect(first).toBeGreaterThan(0);
    expect(await s.prepare()).toBe(0);
    expect(
      await connection.db.collection(COLLECTIONS.marketEvents).countDocuments(),
    ).toBe(first);
  });

  it("keeps each headline once, however many passes and feeds see it", async () => {
    const { s, errors } = service();
    await s.prepare();
    const first = await s.collectGeneral();
    expect(first.map((r) => [r.feed, r.read])).toEqual([
      ["et-markets", 5],
      ["et-stocks", 6],
      ["livemint-markets", 3],
      ["rbi-press", 2],
    ]);
    const hw = await s.collectHeavyweights();
    // Every query answers with the same fixture: kept by the first, then seen.
    expect(hw.map((r) => r.kept)).toEqual([3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const count = await connection.db
      .collection(COLLECTIONS.newsItems)
      .countDocuments();
    expect(count).toBe(5 + 6 + 3 + 2 + 3);
    const again = await s.collectGeneral();
    expect(again.every((r) => r.kept === 0)).toBe(true);
    expect(
      await connection.db.collection(COLLECTIONS.newsItems).countDocuments(),
    ).toBe(count);
    expect(errors).toEqual([]);
  });

  it("backfills the overnight moves first, then reads five days", async () => {
    const { s } = service();
    await s.prepare();
    expect(await s.updateOvernight()).toEqual({
      range: "2y",
      fetched: 4,
      added: 4,
    });
    expect(await s.updateOvernight()).toEqual({
      range: "5d",
      fetched: 4,
      added: 0,
    });
    const context = await new DayContextsRepository(connection.db).forDate(
      "2026-11-30",
    );
    expect(context?.overnight).toMatchObject({
      usDate: "2026-11-27",
      spxChangePct: 1.597,
    });
  });

  it("takes the morning read once a day, keeps it and builds the context from it", async () => {
    const chat = vi.fn<ChatFn>(({ user }) => {
      // Cite the first headline shown, and one id that was never shown.
      const firstId = /^([0-9a-f]{16}) \|/m.exec(user)?.[1] ?? "none";
      return Promise.resolve({
        model: "gemini-test",
        text: JSON.stringify({
          flags: [
            {
              kind: "GLOBAL_RISK_ON",
              detail: "US stocks rallied",
              symbols: [],
              tone: 1,
              headlineIds: [firstId],
            },
            {
              kind: "MAJOR_NEGATIVE",
              detail: "made up",
              symbols: [],
              tone: -1,
              headlineIds: ["ffffffffffffffff"],
            },
          ],
          stockTone: [],
        }),
      });
    });
    const { s } = service(chat);
    await s.prepare();
    await s.collectGeneral();
    await s.updateOvernight();
    const read = await s.morningRead("2026-11-30");
    expect(chat).toHaveBeenCalledTimes(1);
    // Friday 15:30 IST to now: only headlines published in the window.
    expect(read?.headlinesRead).toBeGreaterThan(0);
    expect(read?.flags.map((f) => f.kind)).toEqual(["GLOBAL_RISK_ON"]);
    expect(read?.notes).toEqual([
      'dropped flag MAJOR_NEGATIVE: cites headline id "ffffffffffffffff" not in the set sent',
    ]);
    // A second run the same day reads nothing again.
    expect(await s.morningRead("2026-11-30")).toBeNull();
    expect(chat).toHaveBeenCalledTimes(1);

    const context = await new DayContextsRepository(connection.db).forDate(
      "2026-11-30",
    );
    expect(context).toMatchObject({
      date: "2026-11-30",
      overnight: { usDate: "2026-11-27" },
      flags: [{ kind: "GLOBAL_RISK_ON" }],
      headlinesRead: read?.headlinesRead,
      ai: { provider: "gemini", model: "gemini-test", at: NOW },
      notes: read?.notes,
    });
  });

  it("without a key, keeps a read that says so — and the context carries the note", async () => {
    const { s } = service(undefined, {
      ai: null,
      note: "no AI key configured",
      forbidden: [],
    });
    await s.prepare();
    await s.morningRead("2026-12-10");
    const context = await s.context("2026-12-10");
    expect(context.events.map((e) => e.kind)).toEqual(["FOMC"]);
    expect(context.ai).toBeNull();
    expect(context.notes).toContain("no AI key configured");
  });
});
