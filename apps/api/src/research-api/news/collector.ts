import type { NewsItem } from "@neelkanth/core";
import { toNewsItem, type Feed } from "./feeds.js";
import { parseRss } from "./rss.js";

/** How long one request may take before it is abandoned. */
export const FETCH_TIMEOUT_MS = 15_000;
/** The least time between two Google News requests. */
export const GOOGLE_SPACING_MS = 2_000;

/** Some sites refuse Node's default agent; this one reads as a browser. */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export type FetchText = (url: string) => Promise<string>;
export type ErrorSink = (
  error: unknown,
  context: Record<string, unknown>,
) => void;

/** A GET with a timeout and a browser's User-Agent; a non-2xx answer throws. */
export async function fetchText(
  url: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": BROWSER_USER_AGENT,
      accept:
        "application/rss+xml, application/xml, application/json, text/xml;q=0.9, */*;q=0.8",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new Error(
      `GET ${new URL(url).host} answered ${String(response.status)}`,
    );
  return response.text();
}

export interface CollectDeps {
  fetchText: FetchText;
  keep: (items: readonly NewsItem[]) => Promise<number>;
  now: () => number;
  onError: ErrorSink;
}

export interface FeedResult {
  feed: string;
  /** Items the feed held; null when it could not be read. */
  read: number | null;
  /** Of those, how many were new. */
  kept: number;
}

/**
 * One feed, read once: fetched, parsed, mapped, kept. Never throws — a feed
 * that fails is reported to `onError` and counted as unread; the next slot
 * tries again. No retry here, so a refusing site is not asked twice a minute.
 */
export async function collectFeed(
  feed: Feed,
  deps: CollectDeps,
): Promise<FeedResult> {
  try {
    const xml = await deps.fetchText(feed.url);
    const ingestedAt = deps.now();
    const items = parseRss(xml).map((item) =>
      toNewsItem(item, feed, ingestedAt),
    );
    // One feed can list the same link twice; keep its first appearance.
    const unique = [...new Map(items.map((i) => [i.newsId, i])).values()];
    return {
      feed: feed.id,
      read: items.length,
      kept: await deps.keep(unique),
    };
  } catch (error) {
    deps.onError(error, { where: "newsCollector", feed: feed.id });
    return { feed: feed.id, read: null, kept: 0 };
  }
}

/**
 * Feeds read one after another, `spacingMs` apart (Google News is asked no
 * faster than one query every two seconds). Stops early, between feeds, once
 * `stopped` says so.
 */
export async function collectFeeds(
  feeds: readonly Feed[],
  deps: CollectDeps & {
    spacingMs?: number;
    sleep?: (ms: number) => Promise<void>;
    stopped?: () => boolean;
  },
): Promise<FeedResult[]> {
  // Not unref'd: a CLI pass has nothing else holding the process open.
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const results: FeedResult[] = [];
  for (const [i, feed] of feeds.entries()) {
    if (deps.stopped?.() === true) break;
    if (i > 0 && (deps.spacingMs ?? 0) > 0) await sleep(deps.spacingMs ?? 0);
    results.push(await collectFeed(feed, deps));
  }
  return results;
}
