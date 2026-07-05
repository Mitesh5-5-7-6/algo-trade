"use client";

import { useCallback, useRef, useState } from "react";

/**
 * The always-visible operator rail (plan/06 §3: emergency controls reachable
 * from every page, one action away). PAUSE is one click; KILL is
 * hold-to-confirm — stopping must be easy, but not accidental.
 *
 * Mock milestone: state is local. Milestone 1.9 wires these to
 * POST /control/pause and /control/kill (plan/05 §4.1); note the resume path
 * is ⚠ step-up gated there, which is why this rail has no resume button —
 * re-enabling a killed system is deliberately harder than killing it.
 */
export function OperatorRail() {
  const [engine, setEngine] = useState<"running" | "paused" | "killed">(
    "running",
  );
  const [holding, setHolding] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const beginHold = useCallback(() => {
    if (engine === "killed") return;
    setHolding(true);
    holdTimer.current = setTimeout(() => {
      setEngine("killed");
      setHolding(false);
    }, 1500);
  }, [engine]);

  const cancelHold = useCallback(() => {
    setHolding(false);
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }, []);

  return (
    <aside className="rail">
      <h2 className="panel-title">Operator Controls</h2>

      {engine === "killed" && (
        <div className="halted-banner">
          KILLED — all execution halted. Re-enable requires step-up re-auth from
          Settings.
        </div>
      )}
      {engine === "paused" && (
        <div
          className="halted-banner"
          style={{
            borderColor: "var(--amber)",
            color: "var(--amber)",
            background: "rgba(238,182,83,.08)",
          }}
        >
          PAUSED — no new entries. Exits still allowed.
        </div>
      )}

      <button
        type="button"
        className="btn-pause"
        disabled={engine === "killed"}
        onClick={() => {
          setEngine((state) => (state === "paused" ? "running" : "paused"));
        }}
      >
        {engine === "paused" ? "▶ RESUME TRADING" : "⏸ PAUSE ALL TRADING"}
      </button>

      <button
        type="button"
        className={`btn-kill${holding ? " holding" : ""}`}
        disabled={engine === "killed"}
        onPointerDown={beginHold}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
      >
        <span className="hold-progress" />
        KILL SWITCH
        <span className="kill-sub">HOLD TO CONFIRM</span>
      </button>

      <p className="rail-note">
        The machine trades; you supervise. Pause and kill are the only manual
        levers — there is deliberately no order ticket.
      </p>
    </aside>
  );
}
