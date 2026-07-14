"use client";

import { useDashboardData } from "@/lib/live";
import { formatIN, formatSignedINR, formatTimeIST } from "@/lib/format";

/** Positions — live holdings, snapshot-then-stream over the socket (plan/06 §5). */
export default function PositionsPage() {
  const { positions, strategies } = useDashboardData().snapshot;
  const strategyName = (id: string) =>
    strategies.find((s) => s.config.strategyId === id)?.config.name ?? id;

  return (
    <>
      <h1 className="page-title">Positions</h1>
      <div className="panel">
        <table className="data">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Strategy</th>
              <th>Side</th>
              <th className="num">Qty</th>
              <th className="num">Avg entry</th>
              <th className="num">Realized</th>
              <th className="num">Unrealized</th>
              <th>Opened</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => (
              <tr key={position.positionId}>
                <td className="mono">{position.symbol}</td>
                <td>{strategyName(position.strategyId)}</td>
                <td>
                  <span
                    className={position.side === "LONG" ? "pos" : "neg"}
                    style={{ fontWeight: 700 }}
                  >
                    {position.side}
                  </span>
                </td>
                <td className="num">{formatIN(position.qty)}</td>
                <td className="num">{position.avgEntryPrice.toFixed(2)}</td>
                <td
                  className={`num ${position.realizedPnl < 0 ? "neg" : position.realizedPnl > 0 ? "pos" : ""}`}
                >
                  {formatSignedINR(position.realizedPnl)}
                </td>
                <td
                  className={`num ${position.unrealizedPnl < 0 ? "neg" : "pos"}`}
                >
                  {formatSignedINR(position.unrealizedPnl)}
                </td>
                <td className="mono">
                  {formatTimeIST(position.openedAt, false)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
