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
import { BrokerPanel } from "@/components/broker-panel";

type Limits = LiveSettings["globalRiskLimits"];
interface Draft {
  capitalAllocation: number;
  limits: Limits;
}

/** The F&O-only limits, which are optional and may be cleared back to inherit. */
type FnoLimitKey =
  | "fnoRiskPerTrade"
  | "fnoMaxLotsPerTrade"
  | "fnoMaxCapitalPerTrade"
  | "fnoMaxExposure"
  | "fnoMaxOpenPositions";

const FNO_LIMIT_KEYS: readonly FnoLimitKey[] = [
  "fnoRiskPerTrade",
  "fnoMaxLotsPerTrade",
  "fnoMaxCapitalPerTrade",
  "fnoMaxExposure",
  "fnoMaxOpenPositions",
];

/**
 * Limits with one F&O field set, or omitted entirely when `value` is null.
 *
 * Omission is the point: an absent F&O limit means "inherit the equity one",
 * which is a different state from zero and from any number. It is rebuilt
 * rather than deleted because `exactOptionalPropertyTypes` forbids assigning
 * `undefined` to an optional key, and a dynamic `delete` would only hide that
 * same problem behind a mutation.
 */
function withFnoLimit(
  limits: Limits,
  key: FnoLimitKey,
  value: number | null,
): Limits {
  const next: Limits = {
    maxDailyLoss: limits.maxDailyLoss,
    maxPositionSize: limits.maxPositionSize,
    maxCapitalPerTrade: limits.maxCapitalPerTrade,
    maxOpenPositions: limits.maxOpenPositions,
    maxExposure: limits.maxExposure,
    ...(limits.riskPerTrade === undefined
      ? {}
      : { riskPerTrade: limits.riskPerTrade }),
  };
  for (const candidate of FNO_LIMIT_KEYS) {
    const resolved = candidate === key ? value : (limits[candidate] ?? null);
    if (resolved !== null) next[candidate] = resolved;
  }
  return next;
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

  /**
   * Set or clear one F&O limit.
   *
   * Clearing is a real state, not zero: an absent F&O field means "inherit the
   * equity limit", which is how an operator who has not configured derivatives
   * separately stays on the limits already in force. `exactOptionalPropertyTypes`
   * will not allow assigning `undefined` to an optional key, so clearing
   * removes the key rather than blanking it.
   */
  const editFno = (key: FnoLimitKey, value: number | null) => {
    if (current === null) return;
    setSaved(false);
    setDraft({ ...current, limits: withFnoLimit(current.limits, key, value) });
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

      <BrokerPanel
        connected={snapshot.status.broker.connected}
        detail={snapshot.status.broker.detail}
      />

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
        <div className="field">
          <label htmlFor="riskpertrade">
            Risk per trade —{" "}
            {((current?.limits.riskPerTrade ?? 0.01) * 100).toFixed(2)}% (₹
            {formatIN(
              Math.round(
                (current?.capitalAllocation ?? 0) *
                  (current?.limits.riskPerTrade ?? 0.01),
              ),
            )}
            )
          </label>
          <input
            id="riskpertrade"
            type="range"
            min={25}
            max={500}
            step={25}
            disabled={disabled}
            value={Math.round((current?.limits.riskPerTrade ?? 0.01) * 10_000)}
            onChange={(e) => {
              edit({
                limit: { riskPerTrade: Number(e.target.value) / 10_000 },
              });
            }}
            aria-label="Risk per trade (percent of capital)"
          />
          <span className="hint">
            What one trade is allowed to lose. Size is this budget divided by
            the distance to the stop, rounded down to whole lots — so a value
            below one lot&apos;s risk blocks every signal rather than trading
            smaller.
          </span>
        </div>
        <h2 className="section-heading">F&amp;O risk limits</h2>
        <p className="hint">
          Equity is sized in <strong>shares</strong>; F&amp;O is sized in whole{" "}
          <strong>lots</strong>. A derivative&apos;s smallest tradable unit is
          one lot, so these budgets are divided by what one lot costs and risks
          — never by a per-share figure. Leave a field empty to inherit the
          equity limit above; empty is not zero.
        </p>

        <div className="field">
          <label htmlFor="fnorisk">
            F&amp;O risk per trade (% of capital)
            {current?.limits.fnoRiskPerTrade === undefined
              ? " — inheriting equity"
              : ` — ₹${formatIN(
                  Math.round(
                    current.capitalAllocation * current.limits.fnoRiskPerTrade,
                  ),
                )}`}
          </label>
          <input
            id="fnorisk"
            type="number"
            min={0}
            max={100}
            step={0.25}
            disabled={disabled}
            placeholder={`inherit (${((current?.limits.riskPerTrade ?? 0.01) * 100).toFixed(2)}%)`}
            value={
              current?.limits.fnoRiskPerTrade === undefined
                ? ""
                : current.limits.fnoRiskPerTrade * 100
            }
            onChange={(e) => {
              editFno(
                "fnoRiskPerTrade",
                e.target.value === "" ? null : Number(e.target.value) / 100,
              );
            }}
          />
          <span className="hint">
            What one F&amp;O trade may lose. Divided by one lot&apos;s risk
            (stop distance × lot size) to get the permitted lots. If that is
            below one, the trade is blocked rather than sized smaller — a lot
            cannot be split.
          </span>
        </div>

        <div className="field">
          <label htmlFor="fnolots">F&amp;O max lots per trade</label>
          <input
            id="fnolots"
            type="number"
            min={1}
            step={1}
            disabled={disabled}
            placeholder="no lot ceiling"
            value={current?.limits.fnoMaxLotsPerTrade ?? ""}
            onChange={(e) => {
              editFno(
                "fnoMaxLotsPerTrade",
                e.target.value === "" ? null : Number(e.target.value),
              );
            }}
          />
          <span className="hint">
            A hard ceiling on lots in one trade. Empty means no explicit ceiling
            — the risk, capital and exposure budgets still bind.
          </span>
        </div>

        <div className="field">
          <label htmlFor="fnocap">F&amp;O max capital per trade (₹)</label>
          <input
            id="fnocap"
            type="number"
            min={0}
            step={1000}
            disabled={disabled}
            placeholder={`inherit (₹${formatIN(current?.limits.maxCapitalPerTrade ?? 0)})`}
            value={current?.limits.fnoMaxCapitalPerTrade ?? ""}
            onChange={(e) => {
              editFno(
                "fnoMaxCapitalPerTrade",
                e.target.value === "" ? null : Number(e.target.value),
              );
            }}
          />
          <span className="hint">
            For a bought option this is the premium actually paid, in full. For
            a future it is measured against the contract <em>notional</em>, not
            the margin posted — deliberately conservative until broker margin
            data exists, so futures may be sized smaller than margin would
            allow, never larger.
          </span>
        </div>

        <div className="field">
          <label htmlFor="fnoopen">F&amp;O max open positions</label>
          <input
            id="fnoopen"
            type="number"
            min={1}
            step={1}
            disabled={disabled}
            placeholder={`inherit (${String(current?.limits.maxOpenPositions ?? 0)})`}
            value={current?.limits.fnoMaxOpenPositions ?? ""}
            onChange={(e) => {
              editFno(
                "fnoMaxOpenPositions",
                e.target.value === "" ? null : Number(e.target.value),
              );
            }}
          />
        </div>

        <div className="field">
          <label htmlFor="fnoexposure">
            F&amp;O max exposure (% of capital)
            {current?.limits.fnoMaxExposure === undefined
              ? " — inheriting equity"
              : ` — ₹${formatIN(
                  Math.round(
                    current.capitalAllocation * current.limits.fnoMaxExposure,
                  ),
                )}`}
          </label>
          <input
            id="fnoexposure"
            type="number"
            min={0}
            max={100}
            step={5}
            disabled={disabled}
            placeholder={`inherit (${formatPct(current?.limits.maxExposure ?? 0)})`}
            value={
              current?.limits.fnoMaxExposure === undefined
                ? ""
                : Math.round(current.limits.fnoMaxExposure * 100)
            }
            onChange={(e) => {
              editFno(
                "fnoMaxExposure",
                e.target.value === "" ? null : Number(e.target.value) / 100,
              );
            }}
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

      <TotpSection />

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

/**
 * Self-contained TOTP panel (plan/21 §8). Three states:
 *  1. Not set up  → "Enable 2FA" button → calls /auth/totp/setup
 *  2. Setup done  → shows secret + OTP URI + 6-digit input to verify
 *  3. Enabled     → "Disable 2FA" button (requires current code)
 */
function TotpSection() {
  const [phase, setPhase] = useState<"idle" | "setup" | "disabling">("idle");
  const [secret, setSecret] = useState("");
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null); // null = unknown
  const [busy, setBusy] = useState(false);

  async function startSetup() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.totpSetup();
      setSecret(result.secret);
      setUrl(result.url);
      setPhase("setup");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    }
    setBusy(false);
  }

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      await api.totpVerify(code, secret);
      setEnabled(true);
      setPhase("idle");
      setCode("");
      setSecret("");
      setUrl("");
    } catch {
      setError("Invalid code — check your authenticator app.");
    }
    setBusy(false);
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      await api.totpDisable(code);
      setEnabled(false);
      setPhase("idle");
      setCode("");
    } catch {
      setError("Invalid code — confirm with your authenticator app.");
    }
    setBusy(false);
  }

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <p className="panel-title">Two-Factor Authentication</p>

      {phase === "idle" && (
        <>
          <p className="hint" style={{ marginBottom: 12 }}>
            {enabled === true
              ? "✅ TOTP 2FA is enabled. You'll need your authenticator app to log in."
              : "Add an extra layer of security with a TOTP authenticator app (e.g. Google Authenticator)."}
          </p>
          {enabled === true ? (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setPhase("disabling");
                setCode("");
                setError(null);
              }}
            >
              Disable 2FA…
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => {
                void startSetup();
              }}
            >
              {busy ? "Setting up…" : "Enable 2FA"}
            </button>
          )}
        </>
      )}

      {phase === "setup" && (
        <>
          <p className="hint" style={{ marginBottom: 8 }}>
            Scan this URI in your authenticator app, or enter the secret
            manually:
          </p>
          <div className="field">
            <label htmlFor="totp-secret">Secret</label>
            <input
              id="totp-secret"
              type="text"
              readOnly
              value={secret}
              style={{ fontFamily: "monospace" }}
            />
          </div>
          <div className="field">
            <label htmlFor="totp-url">OTP URL</label>
            <input
              id="totp-url"
              type="text"
              readOnly
              value={url}
              style={{ fontSize: 12, wordBreak: "break-all" }}
            />
          </div>
          <div className="field">
            <label htmlFor="totp-verify">
              Enter the 6-digit code from your app
            </label>
            <input
              id="totp-verify"
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
              }}
              autoFocus
            />
          </div>
          {error && <p className="login-error">{error}</p>}
          <div className="modal-actions">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setPhase("idle");
                setError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={code.length !== 6 || busy}
              onClick={() => {
                void verify();
              }}
            >
              {busy ? "Verifying…" : "Activate 2FA"}
            </button>
          </div>
        </>
      )}

      {phase === "disabling" && (
        <>
          <p className="hint" style={{ marginBottom: 8 }}>
            Enter your current authenticator code to disable 2FA:
          </p>
          <div className="field">
            <label htmlFor="totp-disable">6-digit code</label>
            <input
              id="totp-disable"
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
              }}
              autoFocus
            />
          </div>
          {error && <p className="login-error">{error}</p>}
          <div className="modal-actions">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setPhase("idle");
                setError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={code.length !== 6 || busy}
              onClick={() => {
                void disable();
              }}
            >
              {busy ? "Disabling…" : "Disable 2FA"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
