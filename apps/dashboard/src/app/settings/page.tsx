"use client";

import { useDashboardData } from "@/lib/live";
import { formatIN, formatPct } from "@/lib/format";

/**
 * Settings — capital allocation and global risk limits (plan/06 §4).
 * Controls reproduce the Sentinel design (mono capital field, amber sliders,
 * square-off time). Read-only until milestone 1.9 wires PATCH /settings —
 * where loosening any limit is ⚠ step-up gated while tightening stays
 * frictionless (plan/05 §4.1, plan/21 §5).
 */
export default function SettingsPage() {
  const { settings } = useDashboardData().snapshot;

  return (
    <>
      <h1 className="page-title">Settings</h1>

      <div className="panel" style={{ marginBottom: 16 }}>
        <p className="panel-title">Capital</p>
        <div className="field">
          <label htmlFor="capital">Capital allocation (₹)</label>
          <input
            id="capital"
            type="text"
            readOnly
            value={formatIN(settings.capitalAllocation)}
          />
          <span className="hint">
            The machine's declared budget — availableCapital and exposure are
            computed against it (plan/13 §4).
          </span>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <p className="panel-title">Global risk limits</p>
        <div className="field">
          <label htmlFor="maxloss">
            Max daily loss — ₹{formatIN(settings.maxDailyLoss)}
          </label>
          <input
            id="maxloss"
            type="range"
            readOnly
            disabled
            min={5_000}
            max={50_000}
            value={settings.maxDailyLoss}
          />
          <span className="hint">
            Realized-loss circuit breaker. At 100%: entries auto-halt, exits
            always allowed (plan/14 §4–5).
          </span>
        </div>
        <div className="field">
          <label htmlFor="maxpos">
            Max position size — {formatIN(settings.maxPositionSize)} shares
          </label>
          <input
            id="maxpos"
            type="range"
            readOnly
            disabled
            min={10}
            max={500}
            value={settings.maxPositionSize}
          />
        </div>
        <div className="field">
          <label htmlFor="maxopen">
            Max open positions — {settings.maxOpenPositions} · Max exposure —{" "}
            {formatPct(settings.maxExposure)}
          </label>
          <input
            id="maxopen"
            type="range"
            readOnly
            disabled
            min={1}
            max={12}
            value={settings.maxOpenPositions}
          />
        </div>
        <p className="stepup-note">
          ⚠ Loosening any limit or changing capital requires step-up
          re-authentication. Tightening is always one click.
        </p>
      </div>

      <div className="panel">
        <p className="panel-title">Session</p>
        <div className="field">
          <label htmlFor="squareoff">Square-off time (IST)</label>
          <input
            id="squareoff"
            type="text"
            readOnly
            value={settings.squareOffTime}
            style={{ maxWidth: 120, textAlign: "center" }}
          />
          <span className="hint">
            Open intraday positions are exited by this time, ahead of the 15:30
            close.
          </span>
        </div>
      </div>
    </>
  );
}
