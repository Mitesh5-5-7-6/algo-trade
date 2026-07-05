import type { DayPnl, SystemStatus } from "@/lib/data";
import {
  formatINR,
  formatPct,
  formatSignedINR,
  formatTimeIST,
} from "@/lib/format";

/**
 * The persistent top bar (plan/06 §4, Sentinel design): brand + mode badge,
 * the Day P&L real/unrealized split, and the loss-limit meter whose caption
 * is the plan/14 §5 asymmetry stated as UI copy.
 */
export function TopBar({
  status,
  dayPnl,
}: {
  status: SystemStatus;
  dayPnl: DayPnl;
}) {
  const total = dayPnl.realized + dayPnl.unrealized;
  const used = Math.min(dayPnl.lossLimitUsed, 1);
  const lossSoFar = Math.round(dayPnl.lossLimit * dayPnl.lossLimitUsed);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-name">SENTINEL</span>
        <span className={`mode-badge${status.mode === "live" ? " live" : ""}`}>
          {status.mode === "live" ? "LIVE MODE" : "PAPER MODE"}
        </span>
      </div>

      <div className="kpi">
        <span className="kpi-label">DAY P&amp;L · 09:15 → NOW</span>
        <span className={`kpi-value mono ${total < 0 ? "neg" : "pos"}`}>
          {formatINR(total)}
        </span>
        <span className="kpi-sub mono">
          real{" "}
          <span className={dayPnl.realized < 0 ? "neg" : "pos"}>
            {formatINR(dayPnl.realized)}
          </span>
          {"  ·  unrl "}
          <span className={dayPnl.unrealized < 0 ? "neg" : "pos"}>
            {formatSignedINR(dayPnl.unrealized)}
          </span>
        </span>
      </div>

      <div className="meter">
        <span className="kpi-label">
          LOSS LIMIT{" "}
          <span className="mono" style={{ color: "var(--amber)" }}>
            {formatPct(used)}
          </span>
        </span>
        <div className="meter-track">
          <div
            className={`meter-fill${used >= 1 ? " critical" : ""}`}
            style={{ width: `${String(Math.round(used * 100))}%` }}
          />
        </div>
        <span className="meter-caption mono">
          {formatINR(lossSoFar)} of {formatINR(dayPnl.lossLimit)} daily limit
        </span>
        <span className="meter-caption">
          Entries auto-halt at 100%. Exits always allowed.
          {dayPnl.warningArmedAt !== undefined && (
            <>
              {" "}
              <span className="warn-chip">
                WARNING ARMED {formatTimeIST(dayPnl.warningArmedAt, false)} IST
              </span>
            </>
          )}
        </span>
      </div>
    </header>
  );
}
