"use client";

import { EquityCurve } from "@/components/equity-curve";
import { useDashboardData } from "@/lib/live";
import { formatIN, formatINR, formatSignedINR, formatTimeIST } from "@/lib/format";
import { buildDailyTrades } from "@/lib/trades";

/** P&L — realized vs unrealized, per strategy and global (plan/06 §4, plan/13 §5). */
export default function PnlPage() {
  const { dayPnl, strategies, positions, orders } = useDashboardData().snapshot;
  const dailyTrades = buildDailyTrades(orders);
  const strategyNames = new Map(
    strategies.map(({ config }) => [config.strategyId, config.name]),
  );
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

      <div className="panel trade-ledger-panel">
        <div className="panel-heading">
          <div>
            <p className="panel-title">Daily trade ledger</p>
            <p className="panel-subtitle">
              Completed BUY to SELL trades. Open positions stay in unrealized P&L.
            </p>
          </div>
          <span className="trade-count mono">{dailyTrades.length} trades</span>
        </div>
        <div className="table-scroll">
          <table className="data trade-ledger">
            <thead>
              <tr>
                <th>No.</th>
                <th>Trade details</th>
                <th>Time</th>
                <th className="num">Qty</th>
                <th className="num">Buy @</th>
                <th className="num">Sell @</th>
                <th className="num">Gross P&L</th>
                <th className="num">Broker charges</th>
                <th className="num">Net P&L</th>
                <th>Strategy</th>
                <th>Mode</th>
              </tr>
            </thead>
            <tbody>
              {dailyTrades.length === 0 ? (
                <tr>
                  <td className="empty-table" colSpan={11}>
                    No completed BUY to SELL trades today.
                  </td>
                </tr>
              ) : (
                dailyTrades.map((trade, index) => (
                  <tr key={trade.tradeId}>
                    <td className="mono">{index + 1}</td>
                    <td>
                      <div className="trade-details">
                        <span className="trade-leg buy">BUY {trade.symbol.replace("NSE:", "")}</span>
                        <span className="trade-arrow">-&gt;</span>
                        <span className="trade-leg sell">SELL {trade.symbol.replace("NSE:", "")}</span>
                      </div>
                    </td>
                    <td className="mono">
                      {formatTimeIST(trade.openedAt, false)} - {formatTimeIST(trade.closedAt, false)}
                    </td>
                    <td className="num">{formatIN(trade.qty)}</td>
                    <td className="num">{trade.buyPrice.toFixed(2)}</td>
                    <td className="num">{trade.sellPrice.toFixed(2)}</td>
                    <td className={`num ${trade.grossPnl < 0 ? "neg" : "pos"}`}>
                      {formatSignedINR(trade.grossPnl)}
                    </td>
                    <td className="num neg">{formatINR(trade.charges)}</td>
                    <td className={`num ${trade.pnl < 0 ? "neg" : "pos"}`}>
                      {formatSignedINR(trade.pnl)}
                    </td>
                    <td>{strategyNames.get(trade.strategyId) ?? trade.strategyId}</td>
                    <td className="trade-mode">{trade.mode}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
