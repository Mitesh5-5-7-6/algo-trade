"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EquityCurve } from "@/components/equity-curve";
import { api, type OrderDateRange } from "@/lib/api-client";
import { useDashboardData } from "@/lib/live";
import { qk } from "@/lib/query-keys";
import {
  formatIN,
  formatINR,
  formatSignedINR,
  formatTimeIST,
} from "@/lib/format";
import { buildDailyTrades } from "@/lib/trades";

type RangePreset = "today" | "week" | "month" | "quarter" | "custom";

function todayIST(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00+05:30`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function rangeForPreset(
  preset: Exclude<RangePreset, "custom">,
): OrderDateRange {
  const to = todayIST();
  const days =
    preset === "today"
      ? 0
      : preset === "week"
        ? 6
        : preset === "month"
          ? 29
          : 89;
  return { from: shiftDate(to, -days), to };
}

/** P&L — realized vs unrealized, per strategy and global (plan/06 §4, plan/13 §5). */
export default function PnlPage() {
  const { dayPnl, strategies, positions, orders } = useDashboardData().snapshot;
  const [preset, setPreset] = useState<RangePreset>("today");
  const [range, setRange] = useState<OrderDateRange>(() =>
    rangeForPreset("today"),
  );
  const [rangeError, setRangeError] = useState<string | null>(null);
  const rangeOrders = useQuery({
    queryKey: qk.ordersRange(range.from, range.to),
    queryFn: () => api.orders(range),
    initialData: range.from === range.to ? orders : undefined,
    enabled:
      rangeError === null && range.from.length > 0 && range.to.length > 0,
  });
  const selectedOrders = rangeOrders.data ?? (preset === "today" ? orders : []);
  const dailyTrades = buildDailyTrades(selectedOrders);
  const grossPnl = dailyTrades.reduce((sum, trade) => sum + trade.grossPnl, 0);
  const brokerCharges = dailyTrades.reduce(
    (sum, trade) => sum + trade.charges,
    0,
  );
  const selectedNetPnl = dailyTrades.reduce((sum, trade) => sum + trade.pnl, 0);
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

  const updatePreset = (nextPreset: RangePreset) => {
    setPreset(nextPreset);
    setRangeError(null);
    if (nextPreset !== "custom") {
      setRange(rangeForPreset(nextPreset));
    }
  };

  const updateCustomRange = (field: keyof OrderDateRange, value: string) => {
    const nextRange = { ...range, [field]: value };
    setRange(nextRange);
    setPreset("custom");
    setRangeError(
      nextRange.from > nextRange.to
        ? "Start date must be on or before end date."
        : null,
    );
  };

  return (
    <>
      <h1 className="page-title">P&L</h1>

      <section className="panel pnl-filter" aria-labelledby="pnl-filter-title">
        <div className="panel-heading">
          <div>
            <p className="panel-title" id="pnl-filter-title">
              Compare P&L by date
            </p>
            <p className="panel-subtitle">
              Today is selected by default. Choose a preset or set both dates.
            </p>
          </div>
          <span className="filter-range mono">
            {range.from} to {range.to}
          </span>
        </div>
        <div className="pnl-filter-controls">
          <label className="filter-field">
            <span>Range</span>
            <select
              value={preset}
              onChange={(event) => {
                updatePreset(event.target.value as RangePreset);
              }}
            >
              <option value="today">Today</option>
              <option value="week">This week</option>
              <option value="month">This month</option>
              <option value="quarter">Last 3 months</option>
              <option value="custom">Custom range</option>
            </select>
          </label>
          <label className="filter-field">
            <span>From</span>
            <input
              type="date"
              value={range.from}
              max={range.to}
              onChange={(event) => {
                updateCustomRange("from", event.target.value);
              }}
            />
          </label>
          <label className="filter-field">
            <span>To</span>
            <input
              type="date"
              value={range.to}
              min={range.from}
              onChange={(event) => {
                updateCustomRange("to", event.target.value);
              }}
            />
          </label>
        </div>
        {rangeError !== null && <p className="login-error">{rangeError}</p>}
      </section>

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
            <p className="panel-title">
              Trade ledger ·{" "}
              {preset === "today"
                ? "Today"
                : preset === "custom"
                  ? "Custom range"
                  : preset === "week"
                    ? "This week"
                    : preset === "month"
                      ? "This month"
                      : "Last 3 months"}
            </p>
            <p className="panel-subtitle">
              Completed BUY to SELL trades within the selected date range.
            </p>
          </div>
          <div className="trade-summary">
            <span className="trade-count mono">
              {dailyTrades.length} trades
            </span>
            <span
              className={`trade-count mono ${selectedNetPnl < 0 ? "neg" : "pos"}`}
            >
              Net {formatSignedINR(selectedNetPnl)}
            </span>
          </div>
        </div>
        <div className="range-summary" aria-label="Selected range totals">
          <span>
            Gross{" "}
            <strong className={grossPnl < 0 ? "neg" : "pos"}>
              {formatSignedINR(grossPnl)}
            </strong>
          </span>
          <span>
            Charges <strong className="neg">{formatINR(brokerCharges)}</strong>
          </span>
          <span>
            Net{" "}
            <strong className={selectedNetPnl < 0 ? "neg" : "pos"}>
              {formatSignedINR(selectedNetPnl)}
            </strong>
          </span>
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
                        <span className="trade-leg buy">
                          BUY {trade.symbol.replace("NSE:", "")}
                        </span>
                        <span className="trade-arrow">-&gt;</span>
                        <span className="trade-leg sell">
                          SELL {trade.symbol.replace("NSE:", "")}
                        </span>
                      </div>
                    </td>
                    <td className="mono">
                      {formatTimeIST(trade.openedAt, false)} -{" "}
                      {formatTimeIST(trade.closedAt, false)}
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
                    <td>
                      {strategyNames.get(trade.strategyId) ?? trade.strategyId}
                    </td>
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
