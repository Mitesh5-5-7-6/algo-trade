import type { AskOdds } from "./card-odds.js";

/**
 * The trading process's way to the research service's Time Machine
 * (`POST /odds`), for a trade card. The same service and secret the dashboard
 * relay uses (design §6.1 D16); no research code runs here.
 *
 * Bounded: a free instance asleep can take a minute to wake, and a card's
 * message waits on this, so it gives up after `timeoutMs` and the card goes
 * out saying the odds were not answered.
 */
export function researchOddsClient(options: {
  url: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}): AskOdds {
  const send = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return async (body) => {
    const response = await send(new URL("/odds", options.url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status: response.status, body: payload };
  };
}
