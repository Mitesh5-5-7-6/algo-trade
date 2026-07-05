import { getMockSnapshot } from "@/lib/data";
import { formatSignedINR } from "@/lib/format";

/**
 * Strategies — the operator's primary artifact (plan/06 §4): what the machine
 * runs, its parameters, and whether it is enabled. Create/edit forms and the
 * enable toggle wire to the control-plane API at milestone 1.9
 * (plan/05 §4.1) — until then this surface is read-only.
 */
export default function StrategiesPage() {
  const { strategies } = getMockSnapshot();

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
