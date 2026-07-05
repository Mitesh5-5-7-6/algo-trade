import { EquityCurve } from "@/components/equity-curve";
import { getMockSnapshot } from "@/lib/data";
import { formatSignedINR, formatTimeIST } from "@/lib/format";

/** Overview — the landing surface: day P&L curve + live activity (plan/06 §4, Sentinel design). */
export default function OverviewPage() {
  const { dayPnl, positions, activity, strategies } = getMockSnapshot();
  const openPositions = positions.filter((p) => p.status === "OPEN");
  const enabled = strategies.filter((s) => s.config.enabled);

  return (
    <>
      <h1 className="page-title">Overview</h1>

      <div className="cards">
        <div className="panel">
          <p className="panel-title">Open positions</p>
          <span className="kpi-value mono">{openPositions.length}</span>
        </div>
        <div className="panel">
          <p className="panel-title">Enabled strategies</p>
          <span className="kpi-value mono">
            {enabled.length}
            <span style={{ color: "var(--text-muted)", fontSize: 14 }}>
              {" "}
              / {strategies.length}
            </span>
          </span>
        </div>
        <div className="panel">
          <p className="panel-title">Unrealized P&L</p>
          <span
            className={`kpi-value mono ${dayPnl.unrealized < 0 ? "neg" : "pos"}`}
          >
            {formatSignedINR(dayPnl.unrealized)}
          </span>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <p className="panel-title">Day P&L · 09:15 → now</p>
        <EquityCurve dayPnl={dayPnl} />
      </div>

      <div className="panel">
        <p className="panel-title">Activity</p>
        <div className="activity">
          {activity.map((entry) => (
            <div
              className="activity-row"
              key={`${String(entry.ts)}-${entry.kind}`}
            >
              <span className="activity-ts mono">
                {formatTimeIST(entry.ts, false)}
              </span>
              <span>{entry.message}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
