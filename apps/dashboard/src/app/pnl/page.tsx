"use client";

import { EquityCurve } from "@/components/equity-curve";
import { useDashboardData } from "@/lib/live";
import { formatINR, formatSignedINR } from "@/lib/format";

/** P&L — realized vs unrealized, per strategy and global (plan/06 §4, plan/13 §5). */
export default function PnlPage() {
  const { dayPnl, strategies, positions } = useDashboardData().snapshot;
  const unrealizedByStrategy = new Map<string, number>();
  for (const position of positions) {
    unrealizedByStrategy.set(
      position.strategyId,
      (unrealizedByStrategy.get(position.strategyId) ?? 0) +
        position.unrealizedPnl,
    );
  }

  return (
    <>
      <h1 className="page-title">P&L</h1>

      <div className="cards">
        <div className="panel">
          <p className="panel-title">Day total</p>
          <span
            className={`kpi-value mono ${dayPnl.realized + dayPnl.unrealized < 0 ? "neg" : "pos"}`}
          >
            {formatINR(dayPnl.realized + dayPnl.unrealized)}
          </span>
        </div>
        <div className="panel">
          <p className="panel-title">Realized (feeds the loss limit)</p>
          <span
            className={`kpi-value mono ${dayPnl.realized < 0 ? "neg" : "pos"}`}
          >
            {formatINR(dayPnl.realized)}
          </span>
        </div>
        <div className="panel">
          <p className="panel-title">Unrealized (mark-to-market)</p>
          <span
            className={`kpi-value mono ${dayPnl.unrealized < 0 ? "neg" : "pos"}`}
          >
            {formatSignedINR(dayPnl.unrealized)}
          </span>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <p className="panel-title">Session curve</p>
        <EquityCurve dayPnl={dayPnl} />
      </div>

      <div className="panel">
        <p className="panel-title">Per strategy</p>
        <table className="data">
          <thead>
            <tr>
              <th>Strategy</th>
              <th className="num">Realized</th>
              <th className="num">Unrealized</th>
              <th className="num">Signals</th>
            </tr>
          </thead>
          <tbody>
            {strategies.map(({ config, dayRealizedPnl, signalsToday }) => {
              const unrealized =
                unrealizedByStrategy.get(config.strategyId) ?? 0;
              return (
                <tr key={config.strategyId}>
                  <td style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                    {config.name}
                  </td>
                  <td
                    className={`num ${dayRealizedPnl < 0 ? "neg" : dayRealizedPnl > 0 ? "pos" : ""}`}
                  >
                    {formatSignedINR(dayRealizedPnl)}
                  </td>
                  <td
                    className={`num ${unrealized < 0 ? "neg" : unrealized > 0 ? "pos" : ""}`}
                  >
                    {formatSignedINR(unrealized)}
                  </td>
                  <td className="num">{signalsToday}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
