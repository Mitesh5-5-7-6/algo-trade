/**
 * Setup odds — the "Time Machine" (plan §31; design §6): the form's parsing
 * and the result's wording, kept out of the page so both are unit-tested.
 *
 * Nothing here computes odds. The numbers come from the research service,
 * and this only checks what the operator typed and names what came back.
 */

/** The fields of the form, as typed. */
export interface OddsForm {
  symbol: string;
  side: string;
  entry: string;
  stop: string;
  target: string;
  date: string;
  time: string;
  /** "" for no rule. */
  ruleType: string;
  ruleParams: string;
  /** "" to use every stored session. */
  poolSessions: string;
}

/** What `POST /research/odds` takes. */
export interface OddsRequest {
  symbol: string;
  side: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  date: string;
  time: string;
  rule?: { type: string; params: Record<string, unknown> };
  indexSymbols?: string[];
  poolSessions?: number;
}

export interface OddsInterval {
  lower: number;
  upper: number;
}

/** What it answers — the fields the page shows. */
export interface OddsResponse {
  experimentId: string | null;
  saved: boolean;
  fingerprint: string;
  manifest: {
    plan: { entryBar: number; targetR: number };
    pool: {
      sessions: number;
      barsPerSession: number;
      dates: string[];
      excluded: { date: string; reason: string; bars: number }[];
    };
    resampling: { replays: number; seed: number; window: number };
    history: { rule: { type: string; strategyVersion: string } } | null;
  };
  result: {
    resampled: {
      replays: number;
      targetFirst: number;
      stopFirst: number;
      neither: number;
      gapThroughStop: number;
      averageR: number;
      closeBands: {
        p5: number;
        p25: number;
        p50: number;
        p75: number;
        p95: number;
      };
    };
    resampledVerdict: {
      decided: number;
      targetShare: number | null;
      breakEven: number;
      edgePoints: number | null;
      verdict: string;
    };
    history: {
      sessions: number;
      fired: number;
      targetFirst: number;
      stopFirst: number;
      neither: number;
      otherSide: number;
    } | null;
    historyVerdict: {
      fired: number;
      decided: number;
      targetShare: number | null;
      shareInterval: OddsInterval | null;
      breakEven: number | null;
      edgePoints: number | null;
      averageR: number | null;
      rInterval: OddsInterval | null;
      verdict: string;
    } | null;
  };
}

export interface OddsCoverage {
  symbol: string;
  bars: number;
  firstDate: string;
  lastDate: string;
}

export type ParsedOddsForm =
  { ok: true; request: OddsRequest } | { ok: false; error: string };

const price = (text: string): number | null => {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(value) && value > 0
    ? value
    : null;
};

/**
 * Check the form and build the request, or say what is wrong with it.
 *
 * The research service checks all of this again — it is the authority — but
 * a stop on the wrong side is caught here without a round trip.
 */
export function parseOddsForm(
  form: OddsForm,
  /** Every stored symbol; the indices among them feed a rule's market view. */
  storedSymbols: readonly string[] = [],
): ParsedOddsForm {
  const fail = (error: string): ParsedOddsForm => ({ ok: false, error });
  const symbol = form.symbol.trim().toUpperCase();
  if (symbol === "") return fail("Choose a symbol.");
  if (form.side !== "LONG" && form.side !== "SHORT")
    return fail("Side is LONG or SHORT.");
  const entry = price(form.entry);
  const stop = price(form.stop);
  const target = price(form.target);
  if (entry === null || stop === null || target === null)
    return fail("Entry, stop and target are prices above zero.");
  const long = form.side === "LONG";
  if (long ? stop >= entry : stop <= entry)
    return fail(
      long
        ? "A long's stop must be below its entry."
        : "A short's stop must be above its entry.",
    );
  if (long ? target <= entry : target >= entry)
    return fail(
      long
        ? "A long's target must be above its entry."
        : "A short's target must be below its entry.",
    );
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return fail("Choose a date.");
  if (
    !/^\d{2}:\d{2}$/.test(form.time) ||
    form.time < "09:20" ||
    form.time > "15:25"
  )
    return fail("Time is between 09:20 and 15:25 IST.");

  const request: OddsRequest = {
    symbol,
    side: form.side,
    entry,
    stop,
    target,
    date: form.date,
    time: form.time,
  };

  if (form.poolSessions.trim() !== "") {
    const sessions = Number(form.poolSessions);
    if (!Number.isInteger(sessions) || sessions < 1)
      return fail("Sessions is a whole number, or empty for all of them.");
    request.poolSessions = sessions;
  }

  if (form.ruleType !== "") {
    let params: unknown;
    try {
      params = JSON.parse(
        form.ruleParams.trim() === "" ? "{}" : form.ruleParams,
      );
    } catch {
      return fail("Rule params must be a JSON object.");
    }
    if (typeof params !== "object" || params === null || Array.isArray(params))
      return fail("Rule params must be a JSON object.");
    request.rule = {
      type: form.ruleType,
      params: params as Record<string, unknown>,
    };
    const indices = storedSymbols.filter((s) => s.endsWith("-INDEX"));
    if (indices.length > 0) request.indexSymbols = indices;
  }
  return { ok: true, request };
}

/** 0.359 → "35.9%"; null → "—". */
export function pct(share: number | null): string {
  return share === null ? "—" : `${(share * 100).toFixed(1)}%`;
}

/** 2.6 → "+2.6 points"; null → "—". */
export function points(edge: number | null): string {
  return edge === null
    ? "—"
    : `${edge >= 0 ? "+" : "−"}${Math.abs(edge).toFixed(1)} points`;
}

/** 0.053 → "+0.053R". */
export function r(value: number | null): string {
  return value === null
    ? "—"
    : `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(3)}R`;
}

const VERDICTS: Record<string, { label: string; tone: "pos" | "neg" | "" }> = {
  FAVOURABLE_STRONG: { label: "Strongly favourable", tone: "pos" },
  FAVOURABLE: { label: "Favourable", tone: "pos" },
  NEAR_BREAK_EVEN: { label: "Near break-even", tone: "" },
  UNFAVOURABLE: { label: "Unfavourable", tone: "neg" },
  UNFAVOURABLE_STRONG: { label: "Strongly unfavourable", tone: "neg" },
  INCONCLUSIVE: { label: "Inconclusive", tone: "" },
  INSUFFICIENT_SAMPLE: { label: "Too few trades to judge", tone: "" },
  NO_DECIDED_OUTCOMES: { label: "No replay reached either level", tone: "" },
};

/**
 * A verdict in plain words, and whether to colour it. An unknown verdict is
 * shown as it came rather than guessed at.
 */
export function describeVerdict(verdict: string): {
  label: string;
  tone: "pos" | "neg" | "";
} {
  return VERDICTS[verdict] ?? { label: verdict, tone: "" };
}
