"use client";

import { useState } from "react";

/**
 * The step-up re-auth prompt (plan/21 §5): dangerous actions — resuming after
 * a kill, loosening a risk limit, changing capital — require the operator's
 * password again, so a hijacked-but-idle session can't do the damage. The
 * server enforces this (403 STEP_UP_REQUIRED); this dialog is how the operator
 * answers it.
 */
export function StepUpDialog({
  title,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  busy: boolean;
  error: string | null;
  onConfirm: (password: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-card">
        <p className="panel-title">⚠ Confirm: {title}</p>
        <p className="modal-copy">
          This action loosens a safety control. Re-enter your password to
          confirm it is you.
        </p>
        <div className="field">
          <label htmlFor="stepup-password">Password</label>
          <input
            id="stepup-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && password.length > 0) {
                onConfirm(password);
              }
            }}
          />
        </div>
        {error !== null && <p className="login-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-danger-confirm"
            disabled={busy || password.length === 0}
            onClick={() => {
              onConfirm(password);
            }}
          >
            {busy ? "Confirming…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
