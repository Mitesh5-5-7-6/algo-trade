import { describe, expect, it } from "vitest";
import {
  describeVerdict,
  parseOddsForm,
  pct,
  points,
  r,
  type OddsForm,
} from "./odds";

const form = (over: Partial<OddsForm> = {}): OddsForm => ({
  symbol: "NSE:NIFTYBANK-INDEX",
  side: "LONG",
  entry: "55400",
  stop: "55300",
  target: "55600",
  date: "2026-11-17",
  time: "10:05",
  ruleType: "",
  ruleParams: "",
  poolSessions: "",
  ...over,
});
const STORED = ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX", "NSE:TESTCO-EQ"];

const errorOf = (over: Partial<OddsForm>): string => {
  const parsed = parseOddsForm(form(over), STORED);
  return parsed.ok ? "" : parsed.error;
};

describe("the Time Machine's form", () => {
  it("builds the request from a plan with no rule", () => {
    expect(parseOddsForm(form(), STORED)).toEqual({
      ok: true,
      request: {
        symbol: "NSE:NIFTYBANK-INDEX",
        side: "LONG",
        entry: 55400,
        stop: 55300,
        target: 55600,
        date: "2026-11-17",
        time: "10:05",
      },
    });
  });

  it("tidies the symbol as typed", () => {
    const parsed = parseOddsForm(form({ symbol: " nse:nifty50-index " }));
    expect(parsed.ok && parsed.request.symbol).toBe("NSE:NIFTY50-INDEX");
  });

  it("sends a rule with its params, and the stored indices for its market view", () => {
    const parsed = parseOddsForm(
      form({ ruleType: "ORB", ruleParams: '{"rangeMinutes":15}' }),
      STORED,
    );
    expect(parsed.ok && parsed.request.rule).toEqual({
      type: "ORB",
      params: { rangeMinutes: 15 },
    });
    expect(parsed.ok && parsed.request.indexSymbols).toEqual([
      "NSE:NIFTY50-INDEX",
      "NSE:NIFTYBANK-INDEX",
    ]);
    // Empty params are the rule's own defaults.
    const defaults = parseOddsForm(form({ ruleType: "ORB" }), STORED);
    expect(defaults.ok && defaults.request.rule?.params).toEqual({});
  });

  it("limits the pool only when a number of sessions is given", () => {
    const limited = parseOddsForm(form({ poolSessions: "60" }));
    expect(limited.ok && limited.request.poolSessions).toBe(60);
    const all = parseOddsForm(form());
    expect(all.ok && "poolSessions" in all.request).toBe(false);
    expect(errorOf({ poolSessions: "0" })).toMatch(/whole number/);
    expect(errorOf({ poolSessions: "2.5" })).toMatch(/whole number/);
  });

  it("catches a stop or target on the wrong side, for either side", () => {
    expect(errorOf({ stop: "55500" })).toBe(
      "A long's stop must be below its entry.",
    );
    expect(errorOf({ target: "55400" })).toBe(
      "A long's target must be above its entry.",
    );
    expect(errorOf({ side: "SHORT" })).toBe(
      "A short's stop must be above its entry.",
    );
    expect(errorOf({ side: "SHORT", stop: "55500" })).toBe(
      "A short's target must be below its entry.",
    );
    expect(
      parseOddsForm(form({ side: "SHORT", stop: "55500", target: "55200" })).ok,
    ).toBe(true);
  });

  it("refuses what is not a plan", () => {
    expect(errorOf({ symbol: " " })).toMatch(/symbol/);
    expect(errorOf({ side: "BUY" })).toMatch(/LONG or SHORT/);
    expect(errorOf({ entry: "" })).toMatch(/prices above zero/);
    expect(errorOf({ stop: "abc" })).toMatch(/prices above zero/);
    expect(errorOf({ target: "-5" })).toMatch(/prices above zero/);
    expect(errorOf({ date: "17/11/2026" })).toMatch(/date/);
    expect(errorOf({ time: "09:15" })).toMatch(/09:20 and 15:25/);
    expect(errorOf({ time: "15:30" })).toMatch(/09:20 and 15:25/);
    expect(errorOf({ ruleType: "ORB", ruleParams: "{broken" })).toMatch(
      /JSON object/,
    );
    expect(errorOf({ ruleType: "ORB", ruleParams: "[1]" })).toMatch(
      /JSON object/,
    );
  });
});

describe("the Time Machine's wording", () => {
  it("formats shares, edges and R, and shows a dash for nothing", () => {
    expect(pct(0.359)).toBe("35.9%");
    expect(pct(null)).toBe("—");
    expect(points(2.6)).toBe("+2.6 points");
    expect(points(-1.34)).toBe("−1.3 points");
    expect(points(null)).toBe("—");
    expect(r(0.053)).toBe("+0.053R");
    expect(r(-0.11)).toBe("−0.110R");
    expect(r(null)).toBe("—");
  });

  it("names each verdict plainly, and colours only a direction", () => {
    expect(describeVerdict("FAVOURABLE_STRONG")).toEqual({
      label: "Strongly favourable",
      tone: "pos",
    });
    expect(describeVerdict("UNFAVOURABLE")).toEqual({
      label: "Unfavourable",
      tone: "neg",
    });
    for (const neutral of [
      "NEAR_BREAK_EVEN",
      "INCONCLUSIVE",
      "INSUFFICIENT_SAMPLE",
      "NO_DECIDED_OUTCOMES",
    ])
      expect(describeVerdict(neutral).tone).toBe("");
    expect(describeVerdict("INSUFFICIENT_SAMPLE").label).toBe(
      "Too few trades to judge",
    );
    // Not guessed at: a verdict this build does not know is shown as sent.
    expect(describeVerdict("SOMETHING_NEW")).toEqual({
      label: "SOMETHING_NEW",
      tone: "",
    });
  });
});
