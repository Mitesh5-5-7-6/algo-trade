"use client";

import { useDashboardData } from "@/lib/live";
import { formatSignedINR } from "@/lib/format";

/**
 * Strategies — the operator's primary artifact (plan/06 §4): what the machine
 * runs, its parameters, and whether it is enabled. Read live from the API;
 * create/edit forms and the enable toggle (POST /strategies/:id/enable, ⚠
 * step-up on some settings) are the next increment (plan/05 §4.1).
 */
export default function StrategiesPage() {
  const { strategies } = useDashboardData().snapshot;

  return (
    <>
      <h1 className="page-title">Strategies</h1>
      <div className="panel">
        <table className="data">
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Type</th>
              <th>Symbols</th>
              <th>Params</th>
              <th className="num">Signals today</th>
              <th className="num">Open pos.</th>
              <th className="num">Day P&L</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {strategies.map(
              ({ config, dayRealizedPnl, signalsToday, openPositions }) => (
                <tr key={config.strategyId}>
                  <td style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                    {config.name}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {config.type}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {config.symbols
                      .map((symbol) =>
                        symbol.replace("NSE:", "").replace("-EQ", ""),
                      )
                      .join(", ")}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {Object.entries(config.params)
                      .map(([key, value]) => `${key}=${String(value)}`)
                      .join(" ")}
                  </td>
                  <td className="num">{signalsToday}</td>
                  <td className="num">{openPositions}</td>
                  <td
                    className={`num ${dayRealizedPnl < 0 ? "neg" : dayRealizedPnl > 0 ? "pos" : ""}`}
                  >
                    {formatSignedINR(dayRealizedPnl)}
                  </td>
                  <td>
                    <span
                      className={`badge-status ${config.enabled ? "on" : "off"}`}
                    >
                      {config.enabled ? "ENABLED" : "DISABLED"}
                    </span>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
