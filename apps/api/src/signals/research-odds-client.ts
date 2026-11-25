import type { AskOdds } from "./card-odds.js";

/** Statuses the hosting platform answers for a busy or restarting service. */
const RETRYABLE = new Set([429, 502, 503, 504]);

/**
 * The trading process's way to the research service's Time Machine
 * (`POST /odds`), for a trade card. The same service and secret the dashboard
 * relay uses (design §6.1 D16); no research code runs here.
 *
 * Bounded: a free instance asleep can take a minute to wake, and a card's
 * message waits on this, so it gives up after `timeoutMs` and the card goes
 * out saying the odds were not answered.
 *
 * Retries a platform refusal (429, 502–504). From 2026-11-23 every card got
 * 429 during market hours while the service itself was healthy; one refusal
 * gave up the card's odds for good. It waits the platform's `Retry-After`
 * (capped) or a short pause, within the same overall budget.
 *
 * A body that is not JSON is kept as a short excerpt with the platform's
 * identifying headers, so the card says WHO refused, not only the status.
 */
export function researchOddsClient(options: {
  url: string;
  token: string;
  timeoutMs?: number;
  attempts?: number;
  retryDelayMs?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}): AskOdds {
  const send = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const attempts = options.attempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 4_000;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return async (body) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    let last: { status: number; body: unknown } = { status: 0, body: null };
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const response = await send(new URL("/odds", options.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: deadline,
      });
      const text = await response.text().catch(() => "");
      last = { status: response.status, body: parse(text, response) };
      if (!RETRYABLE.has(response.status) || attempt === attempts) return last;
      await sleep(waitFor(response.headers.get("retry-after"), retryDelayMs));
      if (deadline.aborted) return last;
    }
    return last;
  };
}

/** The JSON body, or a short excerpt naming who answered when it is not JSON. */
function parse(text: string, response: Response): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const via = ["server", "x-render-origin-server", "rndr-id", "retry-after"]
      .map((h) => {
        const v = response.headers.get(h);
        return v === null ? null : `${h}=${v}`;
      })
      .filter((v) => v !== null)
      .join(", ");
    const excerpt = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return {
      error: {
        message: `not JSON${via === "" ? "" : ` (${via})`}: ${excerpt.slice(0, 120) || "empty body"}`,
      },
    };
  }
}

/** Retry-After in seconds, capped at 10 s; the default pause otherwise. */
function waitFor(retryAfter: string | null, fallbackMs: number): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1000, 10_000)
    : fallbackMs;
}
