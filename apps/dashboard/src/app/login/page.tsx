"use client";

import { useState, type SyntheticEvent } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";

/**
 * The one unauthenticated surface (plan/21). There is no signup — accounts are
 * provisioned by the bootstrap CLI. On success the session cookie is set by the
 * API and every query is invalidated so the shell refetches live.
 */
export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.login(email, password);
      await queryClient.invalidateQueries();
      router.replace("/");
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? "Too many attempts — try again shortly."
          : "Invalid email or password.",
      );
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
          />
        </div>

        {error !== null && <p className="login-error">{error}</p>}

        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
