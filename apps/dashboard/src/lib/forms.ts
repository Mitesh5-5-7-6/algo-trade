/**
 * Pure parsers for the strategy form's free-text inputs — extracted so the
 * validation logic is unit-tested without rendering components. Both return
 * null on invalid input; the form shows the error and never submits nulls.
 */

/**
 * "nse:infy-eq, NSE:TCS-EQ" → ["NSE:INFY-EQ", "NSE:TCS-EQ"]; null if empty.
 *
 * Quotes and brackets are stripped because the natural thing to paste into a
 * "comma-separated" box is a chunk of a JSON array — `"NSE:INFY-EQ",
 * "NSE:TCS-EQ"` — and this used to keep the quote characters as part of the
 * symbol. That produced a strategy subscribed to `"NSE:INFY-EQ"` (quotes
 * included), which the broker accepts and never streams: enabled strategy,
 * healthy feed, not one tick, no signal, no order, and nothing anywhere
 * saying why. Three live strategies were sitting in exactly that state.
 */
export function parseSymbols(input: string): string[] | null {
  const symbols = input
    .split(/[,\s]+/)
    .map((s) => s.replace(/^["'[\]]+|["'[\]]+$/g, "").trim().toUpperCase())
    .filter((s) => s.length > 0);
  return symbols.length > 0 ? symbols : null;
}

/**
 * Params arrive as JSON (each strategy's own Zod schema validates them
 * server-side at enable time, plan/15 §4) — here we only require a plain
 * object, so `{"fast": 9}` passes and `[1,2]` / `"x"` / broken JSON do not.
 */
export function parseParams(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}
