/**
 * How long a connected feed may stay silent during market hours before the
 * engine says so. Longer than any plausible gap between ticks on a thin
 * instrument, far shorter than the broker's ~120s idle disconnect.
 */
export const FEED_SILENCE_MS = 60_000;

/**
 * How long a connected feed has delivered nothing while the market is open,
 * in whole seconds — or null when that is not the question (not connected,
 * market shut) or ticks are arriving.
 *
 * "Connected" says the socket is up, not that data flows: a subscription that
 * failed leaves a connected socket that receives nothing, and the status strip
 * read FEED LIVE over a pipeline that evaluated nothing all morning. Measured
 * from the last tick, or — before the first — from when the feed connected,
 * so a fresh connection gets the same grace as a quiet one.
 */
export function feedSilentSeconds(feed: {
  connected: boolean;
  marketOpen: boolean;
  /** When the feed last connected. */
  since: number | undefined;
  /** The last tick, or 0 for none yet. */
  lastTickAt: number;
  now: number;
}): number | null {
  if (!feed.connected || !feed.marketOpen) return null;
  const from = feed.lastTickAt > 0 ? feed.lastTickAt : feed.since;
  if (from === undefined) return null;
  const silent = feed.now - from;
  return silent > FEED_SILENCE_MS ? Math.round(silent / 1000) : null;
}
