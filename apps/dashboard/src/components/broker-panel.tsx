"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";

/**
 * FYERS market-data authorisation (plan/19 §2).
 *
 * The feed needs a broker access token, and the only way to obtain one is the
 * FYERS OAuth round trip. Until this panel existed there was no way to start
 * it from the UI at all, so a fresh deployment could never receive a single
 * tick — the engines ran, strategies sat enabled, and nothing ever fired.
 *
 * This applies to PAPER trading too: paper mode simulates execution but takes
 * its prices from the real feed. Authorising here does not enable live orders;
 * that is `BROKER_MODE`, set on the server.
 */
export function BrokerPanel({ connected }: { connected: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const connect = () => {
    setError(null);
    setPending(true);
    api
      .fyersLoginUrl()
      .then(({ url }) => {
        // A full navigation, not a popup: FYERS returns to our callback, which
        // needs the operator session cookie to know whose token to store.
        window.location.href = url;
      })
      .catch((cause: unknown) => {
        setPending(false);
        setError(
          cause instanceof Error
            ? cause.message
            : "could not reach the broker login endpoint",
        );
      });
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <p className="panel-title">Broker — market data</p>
      <p className="modal-copy">
        {connected ? (
          <>
            FYERS feed is <strong>connected</strong>. Prices are arriving and
            strategies can evaluate.
          </>
        ) : (
          <>
            FYERS feed is <strong>not connected</strong>. Without it no candles
            arrive, so no strategy can produce a signal — paper mode included,
            because paper trading simulates execution but uses real prices.
          </>
        )}
      </p>
      {error !== null && <p className="form-error">{error}</p>}
      <button
        type="button"
        className="btn-enable"
        onClick={connect}
        disabled={pending}
      >
        {pending
          ? "Redirecting…"
          : connected
            ? "Reconnect FYERS…"
            : "Connect FYERS…"}
      </button>
      <p className="modal-copy" style={{ marginTop: 8, opacity: 0.7 }}>
        FYERS access tokens expire daily; reconnect each morning until the
        refresh job is running.
      </p>
    </div>
  );
}
