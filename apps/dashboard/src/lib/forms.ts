/**
 * Pure parsers for the strategy form's free-text inputs — extracted so the
 * validation logic is unit-tested without rendering components. Both return
 * null on invalid input; the form shows the error and never submits nulls.
 */

/** "nse:infy-eq, NSE:TCS-EQ" → ["NSE:INFY-EQ", "NSE:TCS-EQ"]; null if empty. */
export function parseSymbols(input: string): string[] | null {
  const symbols = input
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
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
