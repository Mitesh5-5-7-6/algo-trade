"use client";

import { LevelBar, useNow } from "@/components/level-bar";
import { useDashboardData } from "@/lib/live";
import { formatIN, formatSignedINR, formatTimeIST } from "@/lib/format";
import { age, bareSymbol, price } from "@/lib/trade-card";

/** A price older than this, while the market is open, means the feed has lost it. */
const STALE_MS = 120_000;

type LivePosition = ReturnType<
  typeof useDashboardData
>["snapshot"]["positions"][number] & { ltp?: number; ltpAt?: number };

/**
 * Positions — live holdings with the last price the feed delivered, how old
 * it is, and where it sits between stop and target (2026-11-20). A price that
 * has stopped arriving is shown in red: that is a position whose exits cannot
 * fire (the four option positions of 2026-11-19).
 */
export default function PositionsPage() {
  const { snapshot } = useDashboardData();
  const { strategies } = snapshot;
  const marketOpen = snapshot.status.market.phase === "open";
  const positions = snapshot.positions as LivePosition[];
  const now = useNow();
  const strategyName = (id: string) =>
    strategies.find((s) => s.config.strategyId === id)?.config.name ?? id;
  const total = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

  return (
    <>
      <h1 className="page-title">Positions</h1>
      <div className="cards" style={{ marginBottom: 16 }}>
        <div className="panel">
          <p className="panel-title">Open</p>
          <span className="kpi-value mono">{positions.length}</span>
        </div>
        <div className="panel">
          <p className="panel-title">Unrealized (live)</p>
          <span
            className={`kpi-value mono ${total < 0 ? "neg" : total > 0 ? "pos" : ""}`}
          >
            {formatSignedINR(total)}
          </span>
        </div>
      </div>
      <div className="panel">
        {positions.length === 0 ? (
          <p className="hint">No open positions.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Strategy</th>
                <th>Side</th>
                <th className="num">Qty</th>
                <th className="num">Avg entry</th>
                <th className="num">Live price</th>
                <th>Stop → target</th>
                <th className="num">Unrealized</th>
                <th>Opened</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => {
                const stale =
                  marketOpen &&
                  (position.ltpAt === undefined ||
                    now - position.ltpAt > STALE_MS);
                return (
                  <tr key={position.positionId}>
                    <td className="mono">{bareSymbol(position.symbol)}</td>
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
                    <td className="num">
                      <span className="mono live-price">
                        {price(position.ltp ?? null)}
                      </span>
                      <div className={`price-age ${stale ? "neg" : "hint"}`}>
                        {stale ? "⚠ " : ""}
                        {age(position.ltpAt, now)}
                      </div>
                    </td>
                    <td style={{ minWidth: 180 }}>
                      <LevelBar
                        stop={position.stopLoss}
                        entry={position.avgEntryPrice}
                        target={position.target}
                        ltp={position.ltp}
                      />
                    </td>
                    <td
                      className={`num ${position.unrealizedPnl < 0 ? "neg" : position.unrealizedPnl > 0 ? "pos" : ""}`}
                    >
                      {formatSignedINR(position.unrealizedPnl)}
                    </td>
                    <td className="mono">
                      {formatTimeIST(position.openedAt, false)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="hint" style={{ marginTop: 8 }}>
          Refreshes every 5 seconds. A red price age means no price has arrived
          for that contract for over two minutes during the session — its stop
          and target cannot be judged until it does.
        </p>
      </div>
    </>
  );
}
