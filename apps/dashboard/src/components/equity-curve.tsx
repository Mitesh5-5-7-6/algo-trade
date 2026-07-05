import type { DayPnl } from "@/lib/data";

/**
 * The day P&L curve, rendered exactly as the Sentinel design does it: an SVG
 * polyline with a dashed zero line (indigo) and a dashed loss-limit line
 * (amber). lightweight-charts (plan/04 §10) arrives with the live price
 * charts at milestone 1.9; for this series the design's own SVG is lighter.
 */
export function EquityCurve({ dayPnl }: { dayPnl: DayPnl }) {
  const width = 1000;
  const height = 190;
  const pad = 12;

  const values = dayPnl.curve.map((point) => point.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, -dayPnl.lossLimit);
  const range = max - min || 1;

  const x = (i: number) =>
    pad + (i / Math.max(dayPnl.curve.length - 1, 1)) * (width - 2 * pad);
  const y = (value: number) =>
    pad + ((max - value) / range) * (height - 2 * pad);

  const points = dayPnl.curve
    .map((point, i) => `${x(i).toFixed(1)},${y(point.value).toFixed(1)}`)
    .join(" ");
  const lastPoint = dayPnl.curve[dayPnl.curve.length - 1];
  const total = dayPnl.realized + dayPnl.unrealized;
  const stroke = total < 0 ? "var(--red)" : "var(--green)";

  return (
    <svg
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height: 180, display: "block" }}
      role="img"
      aria-label="Day P&L curve"
    >
      <line
        x1={pad}
        x2={width - pad}
        y1={y(0)}
        y2={y(0)}
        stroke="rgba(148,158,220,.25)"
        strokeWidth="1"
        strokeDasharray="2 5"
      />
      <line
        x1={pad}
        x2={width - pad}
        y1={y(-dayPnl.lossLimit)}
        y2={y(-dayPnl.lossLimit)}
        stroke="rgba(238,182,83,.55)"
        strokeWidth="1"
        strokeDasharray="5 5"
      />
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {lastPoint && (
        <circle
          cx={x(dayPnl.curve.length - 1)}
          cy={y(lastPoint.value)}
          r="3.5"
          fill={stroke}
        />
      )}
    </svg>
  );
}
