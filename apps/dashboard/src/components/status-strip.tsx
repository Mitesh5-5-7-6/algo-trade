import type { SystemStatus } from "@/lib/data";
import { formatTimeIST } from "@/lib/format";

/**
 * Broker / Market / Engine health chips (plan/06 §7: a broken connection must
 * never look like a healthy one — each chip carries an explicit state dot).
 */
/**
 * "NO FEED" rather than "disconnected": the operator needs the consequence,
 * not the state name. A disconnected feed means no candles, so no strategy can
 * ever fire — which otherwise looks identical to a quiet market.
 */
function brokerLabel(state: SystemStatus["broker"]["state"]): string {
  if (state === "connected") return "FEED LIVE";
  if (state === "connecting") return "CONNECTING…";
  return "NO FEED";
}

export function StatusStrip({ status }: { status: SystemStatus }) {
  // "0 signals" alone is ambiguous: a strategy that evaluates all day and
  // finds no setup reads identically to one that never ran. Showing the
  // evaluation count next to it separates them at a glance — "0 signals /
  // 1284 evaluated" is a working quiet day; "0 signals / 0 evaluated" is a
  // broken pipeline (plan/06 §7).
  const evaluated = status.engine.evaluationsToday;
  const engineLabel =
    status.engine.state === "running"
      ? evaluated === undefined
        ? `RUNNING · ${String(status.engine.signalsToday)} signals`
        : `RUNNING · ${String(status.engine.signalsToday)} signals / ${String(evaluated)} evaluated`
      : status.engine.state.toUpperCase();

  return (
    <div className="statusstrip">
      <div className="status-chip">
        <span className="k">Broker</span>
        <span>
          <span className={`dot ${status.broker.connected ? "ok" : "bad"}`} />{" "}
          {status.broker.name} ·{" "}
          <span className="mono">{brokerLabel(status.broker.state)}</span>
        </span>
      </div>
      <div className="status-chip">
        <span className="k">Market</span>
        <span>
          <span
            className={`dot ${status.market.phase === "open" ? "ok" : "warn"}`}
          />{" "}
          {status.market.exchange} {status.market.phase.toUpperCase()} ·{" "}
          <span className="mono">{formatTimeIST(status.market.ts)}</span>
        </span>
      </div>
      <div className="status-chip">
        <span className="k">Engine</span>
        <span>
          <span
            className={`dot ${status.engine.state === "running" ? "ok" : "bad"}`}
          />{" "}
          {engineLabel}
        </span>
      </div>
    </div>
  );
}
