import type { SystemStatus } from "@/lib/data";
import { formatTimeIST } from "@/lib/format";

/**
 * Broker / Market / Engine health chips (plan/06 §7: a broken connection must
 * never look like a healthy one — each chip carries an explicit state dot).
 */
export function StatusStrip({ status }: { status: SystemStatus }) {
  const engineLabel =
    status.engine.state === "running"
      ? `RUNNING · ${String(status.engine.signalsToday)} signals`
      : status.engine.state.toUpperCase();

  return (
    <div className="statusstrip">
      <div className="status-chip">
        <span className="k">Broker</span>
        <span>
          <span className={`dot ${status.broker.connected ? "ok" : "bad"}`} />{" "}
          {status.broker.name} ·{" "}
          <span className="mono">{status.broker.latencyMs}ms</span>
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
