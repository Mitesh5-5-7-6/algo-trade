import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { NewsItemSchema, type NewsItem } from "@neelkanth/core";
import { collectFeed, collectFeeds, type CollectDeps } from "./collector.js";
import {
  canonicalUrl,
  GENERAL_FEEDS,
  googleNewsUrl,
  HEAVYWEIGHT_FEEDS,
  newsIdOf,
  toNewsItem,
  type Feed,
} from "./feeds.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const ET = GENERAL_FEEDS[0] as Feed;
const GOOGLE = HEAVYWEIGHT_FEEDS[0] as Feed;

describe("canonicalUrl and newsIdOf", () => {
  it("drops tracking parameters and the fragment, keeps what addresses the page", () => {
    expect(
      canonicalUrl(
        "https://EconomicTimes.IndiaTimes.com/markets/a/articleshow/1.cms?from=mdr&utm_source=rss&utm_medium=x#top",
        "economictimes",
      ),
    ).toBe("https://economictimes.indiatimes.com/markets/a/articleshow/1.cms");
    // RBI's prid is the page itself.
    expect(
      canonicalUrl(
        "https://www.rbi.org.in/scripts/BS_PressReleaseDisplay.aspx?prid=64061",
        "rbi",
      ),
    ).toBe(
      "https://www.rbi.org.in/scripts/BS_PressReleaseDisplay.aspx?prid=64061",
    );
  });

  it("keeps a Google News link exactly as given", () => {
    const link = "https://news.google.com/rss/articles/CBMiYkFV?oc=5";
    expect(canonicalUrl(link, "google-news")).toBe(link);
  });

  it("is the first 16 hex of sha256 of the canonical URL", () => {
    const url = "https://www.livemint.com/market/x-1.html";
    expect(newsIdOf(url)).toBe(
      createHash("sha256").update(url).digest("hex").slice(0, 16),
    );
    expect(newsIdOf(url)).toMatch(/^[0-9a-f]{16}$/);
    // The same story with and without tracking is one headline.
    expect(newsIdOf(canonicalUrl(`${url}?utm_campaign=y`, "livemint"))).toBe(
      newsIdOf(canonicalUrl(url, "livemint")),
    );
  });
});

describe("the feeds", () => {
  it("are the four checked general feeds and one Google News query per heavyweight", () => {
    expect(GENERAL_FEEDS.map((f) => f.id)).toEqual([
      "et-markets",
      "et-stocks",
      "livemint-markets",
      "rbi-press",
    ]);
    expect(HEAVYWEIGHT_FEEDS).toHaveLength(11);
    expect(GOOGLE).toEqual({
      id: "google-news:NSE:HDFCBANK-EQ",
      source: "google-news",
      url: "https://news.google.com/rss/search?q=%22HDFC%20Bank%22%20when%3A1d&hl=en-IN&gl=IN&ceid=IN:en",
      kind: "heavyweight",
    });
    expect(googleNewsUrl('"Larsen & Toubro" when:1d')).toContain(
      "q=%22Larsen%20%26%20Toubro%22%20when%3A1d",
    );
  });
});

describe("toNewsItem", () => {
  it("keeps the title, the canonical link, the feed and the mapping; dates an undated item when seen", () => {
    const item = toNewsItem(
      {
        title: "SBI Life slips while SBI gains 2% as RBI holds the repo rate",
        link: "https://economictimes.indiatimes.com/a.cms?from=mdr",
        publishedAt: null,
        guid: null,
      },
      ET,
      1_700,
    );
    expect(item).toEqual({
      newsId: newsIdOf("https://economictimes.indiatimes.com/a.cms"),
      source: "economictimes",
      feed: "et-markets",
      url: "https://economictimes.indiatimes.com/a.cms",
      title: "SBI Life slips while SBI gains 2% as RBI holds the repo rate",
      publishedAt: 1_700,
      ingestedAt: 1_700,
      symbols: ["NSE:SBIN-EQ"],
      topics: ["RBI"],
    });
    expect(NewsItemSchema.parse(item)).toEqual(item);
  });
});

describe("collectFeed and collectFeeds", () => {
  const deps = (over: Partial<CollectDeps> = {}) => {
    const kept: NewsItem[][] = [];
    const errors: [unknown, Record<string, unknown>][] = [];
    const d: CollectDeps = {
      fetchText: () => Promise.resolve(fixture("et-stocks.xml")),
      keep: (items) => {
        kept.push([...items]);
        return Promise.resolve(items.length);
      },
      now: () => 5_000,
      onError: (e, c) => errors.push([e, c]),
      ...over,
    };
    return { d, kept, errors };
  };

  it("reads a feed, maps its items and keeps them", async () => {
    const { d, kept } = deps();
    expect(await collectFeed(ET, d)).toEqual({
      feed: "et-markets",
      read: 6,
      kept: 6,
    });
    expect(kept[0]?.map((i) => i.symbols)).toEqual([
      ["NSE:RELIANCE-EQ"],
      [],
      [],
      [],
      ["NSE:ICICIBANK-EQ"],
      ["NSE:SBIN-EQ"],
    ]);
    expect(
      kept[0]?.every((i) => i.ingestedAt === 5_000 && i.feed === "et-markets"),
    ).toBe(true);
  });

  it("keeps a link listed twice in one feed once", async () => {
    const xml = fixture("rbi.xml").replace(/prid=64060/g, "prid=64061");
    const { d, kept } = deps({ fetchText: () => Promise.resolve(xml) });
    expect(await collectFeed(ET, d)).toMatchObject({ read: 2, kept: 1 });
    expect(kept[0]).toHaveLength(1);
  });

  it("reports a failing feed to onError and never throws", async () => {
    const { d, errors } = deps({
      fetchText: () => Promise.reject(new Error("GET x answered 403")),
    });
    expect(await collectFeed(ET, d)).toEqual({
      feed: "et-markets",
      read: null,
      kept: 0,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[1]).toEqual({
      where: "newsCollector",
      feed: "et-markets",
    });
  });

  it("asks Google News one query at a time, two seconds apart, and stops when told", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const { d } = deps({
      fetchText: () => Promise.resolve(fixture("gnews.xml")),
    });
    const results = await collectFeeds(HEAVYWEIGHT_FEEDS.slice(0, 3), {
      ...d,
      spacingMs: 2_000,
      sleep,
    });
    expect(results.map((r) => r.read)).toEqual([3, 3, 3]);
    expect(sleep.mock.calls).toEqual([[2_000], [2_000]]);

    let calls = 0;
    const stopped = await collectFeeds(HEAVYWEIGHT_FEEDS, {
      ...d,
      fetchText: () => {
        calls += 1;
        return Promise.resolve(fixture("gnews.xml"));
      },
      spacingMs: 2_000,
      sleep,
      stopped: () => calls >= 2,
    });
    expect(stopped).toHaveLength(2);
  });
});
