"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { StrategyConfig } from "@neelkanth/core";
import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useDashboardData } from "@/lib/live";
import { formatSignedINR } from "@/lib/format";
import { StrategyDrawer, type DrawerMode } from "@/components/strategy-drawer";

/**
 * Strategies — the operator's primary artifact (plan/06 §4): what the machine
 * runs, its parameters, and whether it is enabled. Fully interactive: create,
 * edit, enable/disable (which provisions/stops the strategy LIVE through the
 * control plane, plan/15 §4), and soft-delete. Enable/disable is deliberately
 * friction-free — stopping a strategy must never be gated (plan/21 §5 gates
 * only the loosening direction, and that lives in Settings).
 */
export default function StrategiesPage() {
  const { strategies } = useDashboardData().snapshot;
  const queryClient = useQueryClient();
  const [drawer, setDrawer] = useState<DrawerMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.strategies });
  };
  const onError = (err: unknown) => {
    setError(err instanceof Error ? err.message : "Action failed.");
  };

  const toggle = useMutation({
    mutationFn: (config: StrategyConfig) =>
      config.enabled
        ? api.disableStrategy(config.strategyId)
        : api.enableStrategy(config.strategyId),
    onSuccess: refresh,
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteStrategy(id),
    onSuccess: refresh,
    onError,
  });

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Strategies</h1>
        <button
          type="button"
          className="btn-primary"
          onClick={() => {
            setDrawer({ kind: "create" });
          }}
        >
          + New strategy
        </button>
      </div>

      {error !== null && <p className="login-error">{error}</p>}

      <div className="panel">
        <table className="data">
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Type</th>
              <th>Symbols</th>
              <th>Params</th>
              <th className="num">Signals today</th>
              <th className="num">Open pos.</th>
              <th className="num">Day P&L</th>
              <th>State</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {strategies.map(
              ({ config, dayRealizedPnl, signalsToday, openPositions }) => (
                <tr key={config.strategyId}>
                  <td style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                    {config.name}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {config.type}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {config.symbols
                      .map((symbol) =>
                        symbol.replace("NSE:", "").replace("-EQ", ""),
                      )
                      .join(", ")}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {Object.entries(config.params)
                      .map(([key, value]) => `${key}=${String(value)}`)
                      .join(" ")}
                  </td>
                  <td className="num">{signalsToday}</td>
                  <td className="num">{openPositions}</td>
                  <td
                    className={`num ${dayRealizedPnl < 0 ? "neg" : dayRealizedPnl > 0 ? "pos" : ""}`}
                  >
                    {formatSignedINR(dayRealizedPnl)}
                  </td>
                  <td>
                    <span
                      className={`badge-status ${config.enabled ? "on" : "off"}`}
                    >
                      {config.enabled ? "ENABLED" : "DISABLED"}
                    </span>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className={config.enabled ? "btn-ghost" : "btn-enable"}
                        disabled={toggle.isPending}
                        onClick={() => {
                          setError(null);
                          toggle.mutate(config);
                        }}
                      >
                        {config.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => {
                          setDrawer({ kind: "edit", config });
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn-ghost danger"
                        disabled={remove.isPending}
                        onClick={() => {
                          setError(null);
                          if (
                            window.confirm(
                              `Delete "${config.name}"? It is disabled and archived (soft delete — history stays).`,
                            )
                          ) {
                            remove.mutate(config.strategyId);
                          }
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>

      {drawer !== null && (
        <StrategyDrawer
          mode={drawer}
          onClose={() => {
            setDrawer(null);
          }}
        />
      )}
    </>
  );
}
