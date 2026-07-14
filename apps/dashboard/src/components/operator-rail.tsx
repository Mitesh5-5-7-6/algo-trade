"use client";

import { useCallback, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useDashboardData } from "@/lib/live";

/**
 * The always-visible operator rail (plan/06 §3: emergency controls reachable
 * from every page, one action away). PAUSE is one click; KILL is
 * hold-to-confirm — stopping must be easy, but not accidental. Both are wired
 * to the control-plane (POST /control/pause, /control/kill).
 *
 * There is deliberately no resume button here: re-enabling a halted system is
 * ⚠ step-up gated (plan/21 §5) and lives on the Settings page — stopping is
 * frictionless, restarting is not.
 */
export function OperatorRail() {
  const queryClient = useQueryClient();
  const { snapshot } = useDashboardData();
  const tradingEnabled = snapshot.status.tradingEnabled;

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: qk.controlStatus });
  }, [queryClient]);

  const pause = useMutation({ mutationFn: api.pause, onSuccess: invalidate });
  const kill = useMutation({ mutationFn: api.kill, onSuccess: invalidate });

  const [holding, setHolding] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const beginHold = useCallback(() => {
    if (!tradingEnabled) return;
    setHolding(true);
    holdTimer.current = setTimeout(() => {
      setHolding(false);
      kill.mutate();
    }, 1500);
  }, [tradingEnabled, kill]);

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

      {!tradingEnabled && (
        <div className="halted-banner">
          HALTED — no new entries; exits still allowed. Re-enable requires
          step-up re-auth from Settings.
        </div>
      )}

      <button
        type="button"
        className="btn-pause"
        disabled={!tradingEnabled || pause.isPending}
        onClick={() => {
          pause.mutate();
        }}
      >
        {pause.isPending ? "PAUSING…" : "⏸ PAUSE ALL TRADING"}
      </button>

      <button
        type="button"
        className={`btn-kill${holding ? " holding" : ""}`}
        disabled={!tradingEnabled || kill.isPending}
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
