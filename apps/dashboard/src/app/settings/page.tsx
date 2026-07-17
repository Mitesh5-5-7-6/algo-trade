"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  isStepUpRequired,
  type LiveSettings,
  type UpdateSettingsBody,
} from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useDashboardData } from "@/lib/live";
import { formatIN, formatPct } from "@/lib/format";
import { StepUpDialog } from "@/components/step-up-dialog";

type Limits = LiveSettings["globalRiskLimits"];
interface Draft {
  capitalAllocation: number;
  limits: Limits;
}

/** What the open step-up dialog will do once the password is entered. */
type PendingStepUp =
  | { kind: "settings"; body: UpdateSettingsBody; title: string }
  | { kind: "resume"; title: string };

/**
 * Settings — capital allocation and global risk limits (plan/06 §4), now
 * editable. The asymmetry is the product (plan/21 §5, plan/14 §5): tightening
 * a limit saves in one click; loosening one — or changing capital, or resuming
 * after a kill — makes the server answer 403 STEP_UP_REQUIRED, and the dialog
 * asks for the operator's password before retrying. The client never decides
 * which direction is which; the server does.
 */
export default function SettingsPage() {
  const { snapshot } = useDashboardData();
  const queryClient = useQueryClient();
  // The full settings document (incl. maxCapitalPerTrade) — same cache entry
  // the snapshot's narrowed view reads.
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [stepUp, setStepUp] = useState<PendingStepUp | null>(null);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const live = settings.data;
  const current: Draft | null =
    draft ??
    (live
      ? {
          capitalAllocation: live.capitalAllocation,
          limits: live.globalRiskLimits,
        }
      : null);

  const edit = (change: Partial<Draft> | { limit: Partial<Limits> }) => {
    if (current === null) return;
    setSaved(false);
    setDraft(
      "limit" in change
        ? { ...current, limits: { ...current.limits, ...change.limit } }
        : { ...current, ...change },
    );
  };

  const finish = () => {
    void queryClient.invalidateQueries({ queryKey: qk.settings });
    void queryClient.invalidateQueries({ queryKey: qk.controlStatus });
    setDraft(null);
    setStepUp(null);
    setStepUpError(null);
    setSaved(true);
  };

  const save = useMutation({
    mutationFn: (body: UpdateSettingsBody) => api.updateSettings(body),
    onSuccess: finish,
    onError: (err: unknown, body) => {
      if (isStepUpRequired(err)) {
        if (stepUp !== null) {
          setStepUpError("Confirmation failed — wrong password?");
          return;
        }
        setStepUp({
          kind: "settings",
          body,
          title: "loosen limits / change capital",
        });
        return;
      }
      setStepUp(null);
      setError(err instanceof Error ? err.message : "Save failed.");
    },
  });

  const resume = useMutation({
    mutationFn: (password: string) => api.resume(password),
    onSuccess: finish,
    onError: (err: unknown) => {
      if (isStepUpRequired(err)) {
        setStepUpError("Confirmation failed — wrong password?");
        return;
      }
      setStepUp(null);
      setError(err instanceof Error ? err.message : "Resume failed.");
    },
  });

  const submit = (stepUpPassword?: string) => {
    if (current === null) return;
    setError(null);
    save.mutate({
      capitalAllocation: current.capitalAllocation,
      globalRiskLimits: current.limits,
      ...(stepUpPassword === undefined ? {} : { stepUpPassword }),
    });
  };

  const tradingEnabled = snapshot.status.tradingEnabled;
  const disabled = current === null;

  return (
    <>
      <h1 className="page-title">Settings</h1>

      {!tradingEnabled && (
        <div className="panel resume-panel">
          <p className="panel-title">Trading is halted</p>
          <p className="modal-copy">
            Pause/kill stopped all entries. Re-enabling is deliberately harder
            than stopping — it requires your password (plan/21 §5).
          </p>
          <button
            type="button"
            className="btn-enable"
            onClick={() => {
              setStepUpError(null);
              setStepUp({ kind: "resume", title: "resume trading" });
            }}
          >
            ▶ Resume trading…
          </button>
        </div>
      )}

      <div className="panel" style={{ marginBottom: 16 }}>
        <p className="panel-title">Capital</p>
        <div className="field">
          <label htmlFor="capital">Capital allocation (₹)</label>
          <input
            id="capital"
            type="number"
            min={0}
            step={10_000}
            disabled={disabled}
            value={current?.capitalAllocation ?? 0}
            onChange={(e) => {
              edit({ capitalAllocation: Number(e.target.value) });
            }}
          />
          <span className="hint">
            The machine&apos;s declared budget — availableCapital and exposure
            are computed against it (plan/13 §4). Changing it requires step-up.
          </span>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <p className="panel-title">Global risk limits</p>
        <div className="field">
          <label htmlFor="maxloss">
            Max daily loss — ₹{formatIN(current?.limits.maxDailyLoss ?? 0)}
          </label>
          <input
            id="maxloss"
            type="range"
            min={5_000}
            max={50_000}
            step={1_000}
            disabled={disabled}
            value={current?.limits.maxDailyLoss ?? 5_000}
            onChange={(e) => {
              edit({ limit: { maxDailyLoss: Number(e.target.value) } });
            }}
          />
          <span className="hint">
            Realized-loss circuit breaker. At 100%: entries auto-halt, exits
            always allowed (plan/14 §4–5).
          </span>
        </div>
        <div className="field">
          <label htmlFor="maxpos">
            Max position size — {formatIN(current?.limits.maxPositionSize ?? 0)}{" "}
            shares
          </label>
          <input
            id="maxpos"
            type="range"
            min={10}
            max={1_000}
            step={10}
            disabled={disabled}
            value={current?.limits.maxPositionSize ?? 10}
            onChange={(e) => {
              edit({ limit: { maxPositionSize: Number(e.target.value) } });
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="maxcap">
            Max capital per trade — ₹
            {formatIN(current?.limits.maxCapitalPerTrade ?? 0)}
          </label>
          <input
            id="maxcap"
            type="number"
            min={1_000}
            step={5_000}
            disabled={disabled}
            value={current?.limits.maxCapitalPerTrade ?? 0}
            onChange={(e) => {
              edit({ limit: { maxCapitalPerTrade: Number(e.target.value) } });
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="maxopen">
            Max open positions — {current?.limits.maxOpenPositions ?? 0} · Max
            exposure — {formatPct(current?.limits.maxExposure ?? 0)}
          </label>
          <input
            id="maxopen"
            type="range"
            min={1}
            max={12}
            disabled={disabled}
            value={current?.limits.maxOpenPositions ?? 1}
            onChange={(e) => {
              edit({ limit: { maxOpenPositions: Number(e.target.value) } });
            }}
          />
          <input
            id="maxexposure"
            type="range"
            min={10}
            max={100}
            step={5}
            disabled={disabled}
            value={Math.round((current?.limits.maxExposure ?? 0.1) * 100)}
            onChange={(e) => {
              edit({ limit: { maxExposure: Number(e.target.value) / 100 } });
            }}
            aria-label="Max exposure (percent of capital)"
          />
        </div>
        <p className="stepup-note">
          ⚠ Loosening any limit or changing capital requires step-up
          re-authentication. Tightening is always one click.
        </p>

        {error !== null && <p className="login-error">{error}</p>}
        {saved && (
          <p className="saved-note">
            Saved — applied to the running risk engine.
          </p>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="btn-ghost"
            disabled={draft === null}
            onClick={() => {
              setDraft(null);
              setError(null);
            }}
          >
            Discard changes
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={draft === null || save.isPending}
            onClick={() => {
              submit();
            }}
          >
            {save.isPending ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>

      <div className="panel">
        <p className="panel-title">Session</p>
        <div className="field">
          <label htmlFor="squareoff">Square-off time (IST)</label>
          <input
            id="squareoff"
            type="text"
            readOnly
            value={
              live?.marketHours.squareOff ?? snapshot.settings.squareOffTime
            }
            style={{ maxWidth: 120, textAlign: "center" }}
          />
          <span className="hint">
            Open intraday positions are exited by this time, ahead of the 15:30
            close.
          </span>
        </div>
      </div>

      {stepUp !== null && (
        <StepUpDialog
          title={stepUp.title}
          busy={save.isPending || resume.isPending}
          error={stepUpError}
          onCancel={() => {
            setStepUp(null);
            setStepUpError(null);
          }}
          onConfirm={(password) => {
            setStepUpError(null);
            if (stepUp.kind === "resume") resume.mutate(password);
            else submit(password);
          }}
        />
      )}
    </>
  );
}
