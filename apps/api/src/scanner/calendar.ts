import { readFileSync } from "node:fs";

/**
 * The NSE trading calendar the backfill and the scan share:
 * `apps/api/scripts/calendars/nse-2025-26.json` (holidays and the weekend
 * special sessions). Resolved from this module, so it is found the same from
 * `src` under the tests and from `dist` in the research service.
 */
export interface TradingCalendar {
  source: string;
  holidays: ReadonlySet<string>;
  specialSessions: ReadonlySet<string>;
}

const DEFAULT_CALENDAR = new URL(
  "../../scripts/calendars/nse-2025-26.json",
  import.meta.url,
);

export function loadTradingCalendar(
  path: string | URL = DEFAULT_CALENDAR,
): TradingCalendar {
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    source?: string;
    holidays?: unknown;
    specialSessions?: unknown;
  };
  const dates = (value: unknown, name: string): Set<string> => {
    if (
      !Array.isArray(value) ||
      !value.every(
        (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d),
      )
    )
      throw new Error(
        `trading calendar ${String(path)}: ${name} must be a list of YYYY-MM-DD dates`,
      );
    return new Set(value as string[]);
  };
  return {
    source: raw.source ?? String(path),
    holidays: dates(raw.holidays, "holidays"),
    specialSessions: dates(raw.specialSessions ?? [], "specialSessions"),
  };
}
