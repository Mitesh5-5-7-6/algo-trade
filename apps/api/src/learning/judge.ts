import {
  describeLesson,
  judgeLesson,
  type Lesson,
  type LessonCondition,
  type LessonStats,
  type SignalFeatures,
} from "@neelkanth/core";

/**
 * The judge (PLAN.md 14.27): a FIXED menu of lessons, each tested on data it
 * did not learn from. Nothing is fitted — no threshold is tuned to the past —
 * so the first 60% of sessions is where a lesson must already help, and the
 * last 40% is where it must help again. The 14.22 meta-lab showed why: a
 * trained review that looked strong on its own period failed on the next.
 */

/** The menu. Thresholds are round numbers chosen before any data was read. */
export const LESSON_MENU: readonly LessonCondition[] = [
  { kind: "HEAVYWEIGHTS_WITH", minShare: 0.6 },
  { kind: "HEAVYWEIGHTS_WITH", minShare: 0.8 },
  { kind: "HEAVYWEIGHTS_NOT_AGAINST", maxAgainstShare: 0.6 },
  { kind: "SKIP_EVENT_DAY", events: ["RBI_POLICY"] },
  { kind: "SKIP_EVENT_DAY", events: ["FOMC"] },
  { kind: "SKIP_EVENT_DAY", events: ["UNION_BUDGET"] },
  { kind: "SKIP_EVENT_DAY", events: ["RESULTS"] },
  { kind: "SKIP_EVENT_DAY", events: ["RBI_POLICY", "FOMC", "UNION_BUDGET"] },
  { kind: "SKIP_EVENT_DAY", events: ["MAJOR_NEGATIVE", "GLOBAL_RISK_OFF"] },
  { kind: "OVERNIGHT_NOT_AGAINST", maxAgainstPct: 0.5 },
  { kind: "OVERNIGHT_NOT_AGAINST", maxAgainstPct: 1 },
  { kind: "OVERNIGHT_WITH", minPct: 0 },
  { kind: "NEWS_NOT_AGAINST" },
  { kind: "SKIP_EXPIRY_DAY" },
  { kind: "INDEX_DAY_WITH", minPct: 0 },
  { kind: "INDEX_DAY_WITH", minPct: 0.3 },
  { kind: "TIME_WINDOW", fromMinute: 10 * 60 + 15, toMinute: 13 * 60 + 30 },
  { kind: "TIME_WINDOW", fromMinute: 9 * 60 + 35, toMinute: 11 * 60 + 30 },
];

/** A past trade with its conditions, as the judge reads it. */
export interface JudgedSample {
  date: string;
  features: SignalFeatures;
  netPct: number;
}

export const LEARN_SHARE = 0.6;
/** Kept trades a period needs before a verdict means anything. */
export const MIN_KEPT = 30;
/** Blocked trades a period needs: a lesson that never blocks shows nothing. */
export const MIN_BLOCKED = 15;
export const FAMILY_ALPHA = 0.05;
const PERMUTATIONS = 2000;

export function statsOf(nets: readonly number[]): LessonStats {
  const wins = nets.filter((n) => n > 0);
  const gross = wins.reduce((a, n) => a + n, 0);
  const loss = -nets.filter((n) => n <= 0).reduce((a, n) => a + n, 0);
  return {
    n: nets.length,
    wins: wins.length,
    winRate: nets.length === 0 ? null : wins.length / nets.length,
    profitFactor: loss > 0 ? gross / loss : null,
    avgNetPct:
      nets.length === 0 ? null : nets.reduce((a, n) => a + n, 0) / nets.length,
  };
}

/** A small seeded generator, so a run's p-values are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * One-sided permutation p-value: how often a random split of the same trades
 * into groups of these sizes shows kept beating blocked by as much.
 */
export function permutationPValue(
  kept: readonly number[],
  blocked: readonly number[],
  seed = 7,
): number | null {
  if (kept.length === 0 || blocked.length === 0) return null;
  const mean = (xs: readonly number[]) =>
    xs.reduce((a, x) => a + x, 0) / xs.length;
  const observed = mean(kept) - mean(blocked);
  const pool = [...kept, ...blocked];
  const next = rng(seed);
  let atLeast = 0;
  for (let p = 0; p < PERMUTATIONS; p += 1) {
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [pool[i], pool[j]] = [pool[j] as number, pool[i] as number];
    }
    if (
      mean(pool.slice(0, kept.length)) - mean(pool.slice(kept.length)) >=
      observed
    )
      atLeast += 1;
  }
  return (atLeast + 1) / (PERMUTATIONS + 1);
}

const pf = (s: LessonStats): number =>
  s.profitFactor ?? (s.n > 0 ? Number.POSITIVE_INFINITY : 0);

/** A stable, readable id: the same condition on the same scope is the same lesson. */
export function lessonIdOf(
  rule: string,
  underlying: string,
  c: LessonCondition,
): string {
  const params = Object.entries(c)
    .filter(([k]) => k !== "kind")
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("+") : String(v)}`)
    .join(",");
  return `${rule}.${underlying}.${c.kind}${params === "" ? "" : `.${params}`}`;
}

interface Split {
  from: string;
  to: string;
  rows: JudgedSample[];
}

function period(split: Split, c: LessonCondition) {
  const kept: number[] = [];
  const blocked: number[] = [];
  let unknown = 0;
  for (const r of split.rows) {
    const j = judgeLesson(c, r.features);
    if (j === "pass") kept.push(r.netPct);
    else if (j === "block") blocked.push(r.netPct);
    else unknown += 1;
  }
  return {
    summary: {
      from: split.from,
      to: split.to,
      all: statsOf([...kept, ...blocked]),
      kept: statsOf(kept),
      blocked: statsOf(blocked),
      unknown,
    },
    kept,
    blocked,
  };
}

/**
 * Judge every lesson on the menu for one rule and underlying. The family for
 * Holm's correction is every lesson in the run that could be tested — so
 * eighteen lessons tried on two indices pay for all thirty-six tries.
 */
export function judgeMenu(
  input: Array<{
    rule: string;
    underlying: string;
    strategyTypes: string[];
    samples: JudgedSample[];
  }>,
  now: number,
  data: Lesson["data"],
  menu: readonly LessonCondition[] = LESSON_MENU,
): Lesson[] {
  const drafts: Array<
    Omit<Lesson, "holmThreshold" | "verdict" | "reasons"> & {
      testable: boolean;
      pre: string[];
    }
  > = [];
  for (const group of input) {
    const dates = [...new Set(group.samples.map((s) => s.date))].sort();
    const cut = dates[Math.floor(dates.length * LEARN_SHARE)] ?? "9999-12-31";
    const learnRows = group.samples.filter((s) => s.date < cut);
    const testRows = group.samples.filter((s) => s.date >= cut);
    const learnSplit: Split = {
      from: dates[0] ?? "",
      to: learnRows.at(-1)?.date ?? "",
      rows: learnRows,
    };
    const testSplit: Split = {
      from: cut,
      to: dates.at(-1) ?? "",
      rows: testRows,
    };
    for (const condition of menu) {
      const learn = period(learnSplit, condition);
      const test = period(testSplit, condition);
      const pre: string[] = [];
      for (const [name, p] of [
        ["learning", learn],
        ["test", test],
      ] as const) {
        if (p.kept.length < MIN_KEPT)
          pre.push(
            `${String(p.kept.length)} kept trades in the ${name} period, ${String(MIN_KEPT)} needed`,
          );
        if (p.blocked.length < MIN_BLOCKED)
          pre.push(
            `${String(p.blocked.length)} blocked trades in the ${name} period, ${String(MIN_BLOCKED)} needed`,
          );
      }
      drafts.push({
        lessonId: lessonIdOf(group.rule, group.underlying, condition),
        scope: {
          rule: group.rule,
          underlying: group.underlying,
          strategyTypes: group.strategyTypes,
        },
        condition,
        summary: describeLesson(condition),
        learn: learn.summary,
        test: test.summary,
        pValue:
          pre.length === 0 ? permutationPValue(test.kept, test.blocked) : null,
        judgedAt: now,
        data,
        testable: pre.length === 0,
        pre,
      });
    }
  }
  // Holm: sort the testable p-values; the k-th smallest must clear alpha/(m-k).
  const testable = drafts
    .filter((d) => d.testable && d.pValue !== null)
    .sort((a, b) => (a.pValue ?? 1) - (b.pValue ?? 1));
  const m = testable.length;
  const threshold = new Map<string, number>();
  let stillRejecting = true;
  testable.forEach((d, k) => {
    const t = FAMILY_ALPHA / (m - k);
    threshold.set(d.lessonId, t);
    if (!stillRejecting || (d.pValue ?? 1) > t) {
      stillRejecting = false;
      threshold.set(d.lessonId, -t); // negative: not rejected (Holm stops at the first failure)
    }
  });

  return drafts.map(({ testable: ok, pre, ...d }) => {
    if (!ok)
      return {
        ...d,
        holmThreshold: null,
        verdict: "WAITING_FOR_DATA" as const,
        reasons: pre,
      };
    const t = threshold.get(d.lessonId) ?? -FAMILY_ALPHA;
    const reasons: string[] = [];
    const helpsLearn = pf(d.learn.kept) > pf(d.learn.all);
    const helpsTest = pf(d.test.kept) > pf(d.test.all);
    if (!helpsLearn)
      reasons.push("it did not improve the trades in the learning period");
    if (!helpsTest)
      reasons.push("it did not improve the trades in the test period");
    if (t < 0)
      reasons.push(
        `the test period's difference could be luck (p = ${(d.pValue ?? 1).toFixed(3)}, needed ≤ ${Math.abs(t).toFixed(4)} after correcting for ${String(m)} lessons tried)`,
      );
    const passed = helpsLearn && helpsTest && t > 0;
    if (passed)
      reasons.push(
        pf(d.test.kept) >= 1
          ? "kept trades were profitable after costs in the test period"
          : "it improved the trades, but the kept trades still lost money after costs in the test period",
      );
    return {
      ...d,
      holmThreshold: Math.abs(t),
      verdict: passed ? ("PASSED" as const) : ("FAILED" as const),
      reasons,
    };
  });
}
