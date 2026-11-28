import { createHash } from "node:crypto";
import type { NewsItem } from "@neelkanth/core";
import type { RssItem } from "./rss.js";
import { HEAVYWEIGHTS, symbolsIn, topicsIn } from "./symbols.js";

/**
 * The feeds headlines are read from (operator decision 2026-11-28: public
 * RSS headlines — title and link only — with their source on every item).
 * Each was checked to answer on 2026-11-28; Business Standard, Moneycontrol
 * and NSE refused and are not here.
 */
export interface Feed {
  /** Kept on every item, so a headline names the feed it came from. */
  id: string;
  source: "economictimes" | "livemint" | "rbi" | "google-news";
  url: string;
  /** General feeds run all day; heavyweight queries only in market hours. */
  kind: "general" | "heavyweight";
}

export const GENERAL_FEEDS: readonly Feed[] = [
  {
    id: "et-markets",
    source: "economictimes",
    url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
    kind: "general",
  },
  {
    id: "et-stocks",
    source: "economictimes",
    url: "https://economictimes.indiatimes.com/markets/stocks/news/rssfeeds/2146842.cms",
    kind: "general",
  },
  {
    id: "livemint-markets",
    source: "livemint",
    url: "https://www.livemint.com/rss/markets",
    kind: "general",
  },
  {
    id: "rbi-press",
    source: "rbi",
    url: "https://www.rbi.org.in/pressreleases_rss.xml",
    kind: "general",
  },
];

/** A Google News search, India edition. */
export function googleNewsUrl(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
}

/** One query per heavyweight: its name, quoted, in the last day. */
export const HEAVYWEIGHT_FEEDS: readonly Feed[] = HEAVYWEIGHTS.map((h) => ({
  id: `google-news:${h.symbol}`,
  source: "google-news",
  url: googleNewsUrl(`"${h.name}" when:1d`),
  kind: "heavyweight",
}));

/** Query parameters that only say where a click came from. */
const TRACKING =
  /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ref|ref_src|from|cmp|cmpid|ocid|_ga|igshid|yclid)$/i;

/**
 * The URL a headline is known by: tracking parameters and the fragment
 * dropped, the host lower-cased. A Google News link is kept exactly as
 * given — its query is part of the article's address, not a click's.
 */
export function canonicalUrl(link: string, source: Feed["source"]): string {
  if (source === "google-news") return link.trim();
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return link.trim();
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()])
    if (TRACKING.test(key)) url.searchParams.delete(key);
  return url.toString();
}

/** The first 16 hex characters of sha256(canonical URL). */
export function newsIdOf(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * A parsed item as a headline to keep. An item with no date that parses is
 * dated when it was first seen — the nearest honest stand-in.
 */
export function toNewsItem(
  item: RssItem,
  feed: Feed,
  ingestedAt: number,
): NewsItem {
  const url = canonicalUrl(item.link, feed.source);
  return {
    newsId: newsIdOf(url),
    source: feed.source,
    feed: feed.id,
    url,
    title: item.title,
    publishedAt: item.publishedAt ?? ingestedAt,
    ingestedAt,
    symbols: symbolsIn(item.title),
    topics: topicsIn(item.title),
  };
}
