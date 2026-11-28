import { describe, expect, it } from "vitest";
import type { SignalFeatures } from "@neelkanth/core";
import {
  isExpiryDate,
  momentumSignals,
  sessionsOf,
} from "./history-signals.js";
import {
  judgeMenu,
  lessonIdOf,
  permutationPValue,
  statsOf,
  type JudgedSample,
} from "./judge.js";

const features = (over: Partial<SignalFeatures> = {}): SignalFeatures => ({
  underlying: "BANKNIFTY",
  direction: 1,
  minuteOfDay: 600,
  indexFromOpenWithPct: 0.2,
  indexDayWithPct: 0.4,
  heavyweights: { total: 5, withCount: 4, againstCount: 1, avgWithPct: 0.5 },
  events: [],
  overnightWithPct: null,
  newsWith: null,
  expiryDay: false,
  ...over,
});

const data = {
  sessions: 200,
  from: "2025-10-01",
  to: "2026-11-27",
  costPct: 0.02,
  decayPctPerHour: 0.005,
};

/** 200 sessions, 2 signals each: one with the heavyweights, one against. */
function samples(withWins: number, againstWins: number): JudgedSample[] {
  const out: JudgedSample[] = [];
  for (let d = 0; d < 200; d += 1) {
    const date = new Date(Date.UTC(2025, 9, 1) + d * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const w = d % 10 < withWins;
    const a = d % 10 < againstWins;
    out.push({ date, features: features(), netPct: w ? 0.5 : -0.3 });
    out.push({
      date,
      features: features({
        heavyweights: {
          total: 5,
          withCount: 1,
          againstCount: 4,
          avgWithPct: -0.5,
        },
      }),
      netPct: a ? 0.5 : -0.3,
    });
  }
  return out;
}

describe("the judge (14.27)", () => {
  it("passes a lesson that helps in both periods by more than luck", () => {
    const lessons = judgeMenu(
      [
        {
          rule: "MOMENTUM",
          underlying: "BANKNIFTY",
          strategyTypes: ["INDEX_OPTION_MOMENTUM"],
          samples: samples(7, 2),
        },
      ],
      1,
      data,
      [{ kind: "HEAVYWEIGHTS_WITH", minShare: 0.6 }],
    );
    expect(lessons[0]?.verdict).toBe("PASSED");
    expect(lessons[0]?.test.kept.winRate).toBeCloseTo(0.7, 6);
    expect(lessons[0]?.reasons.at(-1)).toContain("profitable after costs");
  });

  it("fails a lesson that separates nothing", () => {
    const [lesson] = judgeMenu(
      [
        {
          rule: "MOMENTUM",
          underlying: "BANKNIFTY",
          strategyTypes: ["INDEX_OPTION_MOMENTUM"],
          samples: samples(4, 4),
        },
      ],
      1,
      data,
      [{ kind: "HEAVYWEIGHTS_WITH", minShare: 0.6 }],
    );
    expect(lesson?.verdict).toBe("FAILED");
  });

  it("waits for data when a lesson's input is missing", () => {
    const [lesson] = judgeMenu(
      [
        {
          rule: "MOMENTUM",
          underlying: "BANKNIFTY",
          strategyTypes: ["INDEX_OPTION_MOMENTUM"],
          samples: samples(7, 2),
        },
      ],
      1,
      data,
      [{ kind: "NEWS_NOT_AGAINST" }],
    );
    expect(lesson?.verdict).toBe("WAITING_FOR_DATA");
    expect(lesson?.test.unknown).toBeGreaterThan(0);
  });

  it("makes every lesson pay for the others tried (Holm)", () => {
    // The same weak edge passes alone but not as one of many tries.
    const weak = samples(6, 4);
    const one = judgeMenu(
      [
        {
          rule: "M",
          underlying: "BANKNIFTY",
          strategyTypes: ["X"],
          samples: weak,
        },
      ],
      1,
      data,
      [{ kind: "HEAVYWEIGHTS_WITH", minShare: 0.6 }],
    )[0];
    const many = judgeMenu(
      [
        {
          rule: "M",
          underlying: "BANKNIFTY",
          strategyTypes: ["X"],
          samples: weak,
        },
      ],
      1,
      data,
      [
        0.6, 0.61, 0.62, 0.63, 0.64, 0.65, 0.66, 0.67, 0.68, 0.69, 0.7, 0.71,
      ].map((minShare) => ({
        kind: "HEAVYWEIGHTS_WITH" as const,
        minShare,
      })),
    );
    expect(one?.holmThreshold).toBeCloseTo(0.05, 6);
    expect(many.every((l) => (l.holmThreshold ?? 1) <= 0.05)).toBe(true);
    expect(Math.min(...many.map((l) => l.holmThreshold ?? 1))).toBeCloseTo(
      0.05 / 12,
      6,
    );
  });

  it("names a lesson the same way every run", () => {
    expect(
      lessonIdOf("MOMENTUM", "NIFTY", {
        kind: "SKIP_EVENT_DAY",
        events: ["RBI_POLICY", "FOMC"],
      }),
    ).toBe("MOMENTUM.NIFTY.SKIP_EVENT_DAY.events=RBI_POLICY+FOMC");
  });

  it("computes stats and a reproducible p-value", () => {
    expect(statsOf([1, -0.5, 2, -0.5])).toMatchObject({
      n: 4,
      wins: 2,
      winRate: 0.5,
      profitFactor: 3,
    });
    const p1 = permutationPValue([1, 1, 1, 0.5], [-1, -1, -0.5, -1]);
    expect(p1).toBe(permutationPValue([1, 1, 1, 0.5], [-1, -1, -0.5, -1]));
    expect(p1).toBeLessThan(0.05);
  });
});

describe("history signals (14.27)", () => {
  it("knows Tuesday expiries: weekly NIFTY, last-Tuesday BANK NIFTY", () => {
    expect(isExpiryDate("2026-11-24", "NIFTY")).toBe(true);
    expect(isExpiryDate("2026-11-24", "BANKNIFTY")).toBe(true); // last Tuesday of November
    expect(isExpiryDate("2026-11-17", "BANKNIFTY")).toBe(false);
    expect(isExpiryDate("2026-11-25", "NIFTY")).toBe(false);
  });

  it("fires a breakout above the EMA once a day and walks it to the target", () => {
    // Two sessions of 75 five-minute bars; the second breaks out at 10:00.
    const day = (date: string, prices: (i: number) => number) =>
      Array.from({ length: 75 }, (_, i) => {
        const ts = Date.parse(`${date}T03:45:00Z`) + i * 300_000;
        const p = prices(i);
        return { ts, open: p, high: p + 5, low: p - 5, close: p };
      });
    const flat = day("2026-11-26", () => 50_000);
    const breakout = day("2026-11-27", (i) =>
      i < 9 ? 50_000 : 50_000 + (i - 8) * 60,
    );
    const signals = momentumSignals(
      "BANKNIFTY",
      sessionsOf([...flat, ...breakout]),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      direction: 1,
      date: "2026-11-27",
      prevClose: 50_000,
    });
    expect(signals[0]?.netPct).toBeGreaterThan(3); // the 3.12% target, less costs
  });
});
