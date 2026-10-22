import { hasTrustedVolume, intervalMs, istDateKey } from "@neelkanth/core";
import type { IndicatorSpec } from "@neelkanth/indicators";
import { createStrategyRegistry } from "@neelkanth/strategies";
import type { DayRun } from "./day.js";
import { DEFAULT_PRECEDING_BARS, type TradeEvidence } from "./evidence.js";

/** Bumped whenever what a chart specification holds changes (Phase 8 D4). */
export const CHART_SPEC_VERSION = "1";

/** An overlay or a lower pane, named — a client draws it from the bars. */
export interface ChartOverlay {
  kind: IndicatorSpec["kind"];
  period?: number;
  /** Price-scaled overlays share the candles' pane; the rest get their own. */
  pane: "price" | "lower";
}

export interface ChartMarker {
  kind: "PATTERN" | "ENTRY" | "EXIT" | "BLOCKED";
  /** The bar it sits on (bucket start), or a fill's own time. */
  ts: number;
  label: string;
  price?: number;
}

/**
 * A chart, as a specification (spec §7): what to draw, never a drawing. It
 * regenerates from the bars, survives a detector redefinition, and stays tied
 * to the structured evidence its markers name.
 */
export interface ChartSpec {
  chartId: string;
  version: string;
  symbol: string;
  interval: string;
  /** First and last bar shown — bucket starts, both inclusive. */
  start: number;
  end: number;
  overlays: ChartOverlay[];
  markers: ChartMarker[];
  annotations: string[];
}

const PRICE_PANE = new Set<IndicatorSpec["kind"]>(["ema", "sma", "vwap"]);
const VOLUME_DERIVED = new Set<IndicatorSpec["kind"]>(["vwap", "avgVolume"]);

/**
 * Overlays for these indicator specs on these bars. A volume-derived one
 * (VWAP, average volume) is drawn only when every bar's volume is REAL —
 * otherwise omitted, and the omission annotated (Phase 5 D3): a chart is
 * evidence too, and a line drawn from untrusted volume is a conclusion.
 */
function overlaysFor(
  specs: readonly IndicatorSpec[],
  realVolume: boolean,
  untrustedBars: number,
): { overlays: ChartOverlay[]; annotations: string[] } {
  const seen = new Map<string, ChartOverlay>();
  const omitted = new Set<string>();
  for (const spec of specs) {
    const id =
      "period" in spec ? `${spec.kind}${String(spec.period)}` : spec.kind;
    if (VOLUME_DERIVED.has(spec.kind) && !realVolume) {
      omitted.add(id);
      continue;
    }
    if (!seen.has(id))
      seen.set(id, {
        kind: spec.kind,
        ...("period" in spec ? { period: spec.period } : {}),
        pane: PRICE_PANE.has(spec.kind) ? "price" : "lower",
      });
  }
  const overlays = [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, o]) => o);
  const annotations = [...omitted]
    .sort()
    .map(
      (id) =>
        `${id} omitted: volume is not REAL on ${String(untrustedBars)} bar(s)`,
    );
  return { overlays, annotations };
}

/** The indicators a strategy reads on a symbol, as it was configured. */
function indicatorsOf(
  type: string,
  params: Record<string, unknown>,
  symbol: string,
): readonly IndicatorSpec[] {
  return createStrategyRegistry()
    .instantiate(type, params, symbol)
    .requiredIndicators();
}

/**
 * The day's chart (Phase 8 D4): every bar of the day, the trend EMA and each
 * evaluated strategy's own indicators, every pattern, every entry and exit,
 * and every proposal risk blocked.
 */
export function dayChart(
  day: DayRun,
  symbol: string,
  evidence: readonly TradeEvidence[],
): ChartSpec {
  const bars = day.bars.filter(
    (b) => b.symbol === symbol && istDateKey(b.ts) === day.date,
  );
  const first = bars[0];
  const last = bars.at(-1);
  if (first === undefined || last === undefined)
    throw new Error(`${symbol} has no bars on ${day.date}`);
  const untrusted = bars.filter((b) => !hasTrustedVolume(b)).length;
  const specs: IndicatorSpec[] = [
    { kind: "ema", period: day.evaluation.manifest.models.regime.emaPeriod },
    { kind: "vwap" },
  ];
  for (const s of day.evaluation.manifest.strategies)
    if (s.eligible && s.symbol === symbol)
      specs.push(...indicatorsOf(s.type, s.params, symbol));
  const { overlays, annotations } = overlaysFor(
    specs,
    untrusted === 0,
    untrusted,
  );

  const markers: ChartMarker[] = [];
  for (const o of day.occurrences.filter((x) => x.symbol === symbol))
    markers.push({
      kind: "PATTERN",
      ts: o.ts,
      label: `${o.patternId} ${o.direction}`,
    });
  for (const e of evidence.filter((x) => x.symbol === symbol)) {
    markers.push({
      kind: "ENTRY",
      ts: e.entry.time,
      label: `${e.strategyType} ${e.side}`,
      price: e.entry.price,
    });
    if (e.exit.time !== null && e.exit.price !== null)
      markers.push({
        kind: "EXIT",
        ts: e.exit.time,
        label: `${e.strategyType} ${e.exit.reason}`,
        price: e.exit.price,
      });
  }
  for (const run of day.evaluation.runs.filter((r) => r.symbol === symbol)) {
    const blocked = new Set(
      run.trail.riskLogs
        .filter((l) => l.decision === "blocked")
        .map((l) => l.signalId),
    );
    for (const s of day.strategyDays.find(
      (d) => d.strategyType === run.strategyType && d.symbol === symbol,
    )?.signals ?? [])
      if (blocked.has(s.signalId))
        markers.push({
          kind: "BLOCKED",
          ts: s.dataProvenance?.barTs ?? s.ts,
          label: `${run.strategyType} ${s.side} blocked`,
        });
  }
  return {
    chartId: `${day.date}|${symbol}|day`,
    version: CHART_SPEC_VERSION,
    symbol,
    interval: day.evaluation.interval,
    start: first.ts,
    // Through the last bar — or a square-off filled after it.
    end: Math.max(
      last.ts,
      ...markers.map(
        (m) =>
          Math.floor(m.ts / intervalMs(day.evaluation.interval)) *
          intervalMs(day.evaluation.interval),
      ),
    ),
    overlays,
    markers: sortMarkers(markers),
    annotations,
  };
}

/**
 * One chart per Trade: from N bars before its entry bar — what preceded it —
 * to two bars after its exit, its strategy's own indicators, the patterns
 * that preceded it, its entry and exit.
 */
export function tradeChart(
  day: DayRun,
  e: TradeEvidence,
  precedingBars: number = DEFAULT_PRECEDING_BARS,
): ChartSpec {
  const barMs = intervalMs(day.evaluation.interval);
  const symbolBars = day.bars.filter((b) => b.symbol === e.symbol);
  const exitBar =
    e.exit.time === null
      ? e.entry.barTs
      : Math.floor(e.exit.time / barMs) * barMs;
  const inSpan = symbolBars.filter(
    (b) =>
      b.ts >= e.entry.barTs - precedingBars * barMs &&
      b.ts <= exitBar + 2 * barMs,
  );
  const start = inSpan[0]?.ts ?? e.entry.barTs;
  // A square-off can fill after the session's last bar; the chart still
  // reaches its own exit marker.
  const end = Math.max(inSpan.at(-1)?.ts ?? exitBar, exitBar);
  const untrusted = inSpan.filter((b) => !hasTrustedVolume(b)).length;
  const strategy = day.evaluation.manifest.strategies.find(
    (s) => s.eligible && s.type === e.strategyType && s.symbol === e.symbol,
  );
  const specs =
    strategy?.eligible === true
      ? indicatorsOf(strategy.type, strategy.params, e.symbol)
      : [];
  const { overlays, annotations } = overlaysFor(
    specs,
    untrusted === 0,
    untrusted,
  );
  const markers: ChartMarker[] = [
    ...e.preceding.patterns.map((p): ChartMarker => ({
      kind: "PATTERN",
      ts: p.ts,
      label: `${p.patternId} ${p.direction}`,
    })),
    {
      kind: "ENTRY",
      ts: e.entry.time,
      label: `${e.side} ${e.entry.reason ?? ""}`.trim(),
      price: e.entry.price,
    },
    ...(e.exit.time === null || e.exit.price === null
      ? []
      : [
          {
            kind: "EXIT" as const,
            ts: e.exit.time,
            label: e.exit.reason,
            price: e.exit.price,
          },
        ]),
  ];
  return {
    chartId: `${day.date}|${e.symbol}|trade|${e.key}`,
    version: CHART_SPEC_VERSION,
    symbol: e.symbol,
    interval: day.evaluation.interval,
    start,
    end,
    overlays,
    markers: sortMarkers(markers),
    annotations: [
      `${e.outcome.result} ${String(e.outcome.net)} net; excursion +${String(e.excursion.favourable)} / −${String(e.excursion.adverse)} per unit`,
      ...annotations,
    ],
  };
}

const ORDER: Record<ChartMarker["kind"], number> = {
  PATTERN: 0,
  BLOCKED: 1,
  ENTRY: 2,
  EXIT: 3,
};
function sortMarkers(markers: ChartMarker[]): ChartMarker[] {
  return markers.sort(
    (a, b) =>
      a.ts - b.ts ||
      ORDER[a.kind] - ORDER[b.kind] ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );
}
