"use client";

import { useState, type SyntheticEvent } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/**
 * The one unauthenticated surface (plan/21). There is no signup — accounts are
 * provisioned by the bootstrap CLI. On success the session cookie is set by the
 * API and every query is invalidated so the shell refetches live.
 *
 * If the user has TOTP enabled, the API returns { requiresTotp: true } and the
 * form reveals a second-stage input for the 6-digit code (plan/21 §8).
 */
export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpToken, setTotpToken] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { status, data } = await api.loginRaw(
        email,
        password,
        needsTotp ? totpToken : undefined,
      );

      if (status === 401 && data.requiresTotp === true) {
        setNeedsTotp(true);
        setBusy(false);
        return;
      }

      if (status === 401 || status === 429) {
        setError(
          status === 429
            ? "Too many attempts — try again shortly."
            : "Invalid email or password.",
        );
        setBusy(false);
        return;
      }

      if (status >= 200 && status < 300) {
        await queryClient.invalidateQueries();
        router.replace("/");
        return;
      }

      setError("Unexpected error. Please try again.");
      setBusy(false);
    } catch {
      setError("Network error — is the API running?");
      setBusy(false);
    }
  }

  function onSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    void submit();
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="login-brand">SENTINEL</div>
        <p className="login-sub">Operator sign-in</p>

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
            required
            disabled={needsTotp}
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            required
            disabled={needsTotp}
          />
        </div>

        {needsTotp && (
          <div className="field">
            <label htmlFor="totpToken">Authenticator Code</label>
            <input
              id="totpToken"
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              autoComplete="one-time-code"
              placeholder="6-digit code"
              value={totpToken}
              onChange={(e) => {
                setTotpToken(e.target.value);
              }}
              required
              autoFocus
            />
          </div>
        )}

        {error !== null && <p className="login-error">{error}</p>}

        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Signing in…" : needsTotp ? "Verify & Sign in" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
