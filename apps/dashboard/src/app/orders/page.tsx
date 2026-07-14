"use client";

import { useDashboardData } from "@/lib/live";
import { formatIN, formatTimeIST } from "@/lib/format";

const STATUS_COLOR: Record<string, string> = {
  FILLED: "var(--green)",
  PLACED: "var(--indigo)",
  PENDING: "var(--amber)",
  REJECTED: "var(--red)",
  CANCELLED: "var(--text-muted)",
};

/** Orders — history + live status (plan/06 §4). */
export default function OrdersPage() {
  const { orders } = useDashboardData().snapshot;

  return (
    <>
      <h1 className="page-title">Orders</h1>
      <div className="panel">
        <table className="data">
          <thead>
            <tr>
              <th>Time</th>
              <th>Order</th>
              <th>Symbol</th>
              <th>Side</th>
              <th className="num">Qty</th>
              <th>Type</th>
              <th className="num">Filled @</th>
              <th className="num">Charges</th>
              <th>Status</th>
              <th>Mode</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.orderId}>
                <td className="mono">
                  {formatTimeIST(order.createdAt, false)}
                </td>
                <td className="mono">{order.orderId}</td>
                <td className="mono">{order.symbol}</td>
                <td>
                  <span
                    className={order.side === "BUY" ? "pos" : "neg"}
                    style={{ fontWeight: 700 }}
                  >
                    {order.side}
                  </span>
                </td>
                <td className="num">{formatIN(order.qty)}</td>
                <td>{order.type}</td>
                <td className="num">
                  {order.filledPrice === undefined
                    ? "—"
                    : order.filledPrice.toFixed(2)}
                </td>
                <td className="num">
                  {order.charges === undefined ? "—" : order.charges.toFixed(2)}
                </td>
                <td>
                  <span
                    style={{
                      color: STATUS_COLOR[order.status],
                      fontWeight: 700,
                      fontSize: 12,
                    }}
                  >
                    {order.status}
                  </span>
                </td>
                <td style={{ textTransform: "uppercase", fontSize: 11 }}>
                  {order.mode}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
