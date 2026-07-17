"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StrategyConfig } from "@neelkanth/core";
import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { parseParams, parseSymbols } from "@/lib/forms";

export type DrawerMode =
  { kind: "create" } | { kind: "edit"; config: StrategyConfig };

/**
 * Create/edit a strategy (plan/06 §4, the "Strategy config drawer" surface of
 * the Sentinel design). Symbols are comma-separated text; params are JSON —
 * the server's per-type Zod schema is the real validator at enable time
 * (plan/15 §4), this form only refuses obviously-malformed input. Writes go
 * through the control plane, which drives the live runtime too.
 */
export function StrategyDrawer({
  mode,
  onClose,
}: {
  mode: DrawerMode;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const editing = mode.kind === "edit" ? mode.config : null;

  const types = useQuery({
    queryKey: qk.strategyTypes,
    queryFn: api.strategyTypes,
    enabled: editing === null, // type is immutable once created
  });

  const [type, setType] = useState(editing?.type ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [symbolsText, setSymbolsText] = useState(
    editing?.symbols.join(", ") ?? "",
  );
  const [paramsText, setParamsText] = useState(
    JSON.stringify(editing?.params ?? {}, null, 2),
  );
  const [enabled, setEnabled] = useState(editing?.enabled ?? false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const symbols = parseSymbols(symbolsText);
      const params = parseParams(paramsText);
      if (symbols === null) throw new Error("Enter at least one symbol.");
      if (params === null) throw new Error("Params must be a JSON object.");
      if (editing !== null) {
        return api.updateStrategy(editing.strategyId, {
          name,
          params,
          symbols,
        });
      }
      if (type.length === 0) throw new Error("Pick a strategy type.");
      return api.createStrategy({ type, name, params, symbols, enabled });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.strategies });
      onClose();
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : "Save failed.");
    },
  });

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-card drawer">
        <p className="panel-title">
          {editing !== null ? `Edit — ${editing.name}` : "New strategy"}
        </p>

        {editing === null && (
          <div className="field">
            <label htmlFor="s-type">Type</label>
            <select
              id="s-type"
              value={type}
              onChange={(e) => {
                setType(e.target.value);
              }}
            >
              <option value="">Select…</option>
              {(types.data ?? []).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="field">
          <label htmlFor="s-name">Name</label>
          <input
            id="s-name"
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            placeholder="EMA 9/21 · index majors"
          />
        </div>

        <div className="field">
          <label htmlFor="s-symbols">Symbols (comma-separated)</label>
          <input
            id="s-symbols"
            type="text"
            value={symbolsText}
            onChange={(e) => {
              setSymbolsText(e.target.value);
            }}
            placeholder="NSE:RELIANCE-EQ, NSE:HDFCBANK-EQ"
          />
        </div>

        <div className="field">
          <label htmlFor="s-params">Params (JSON)</label>
          <textarea
            id="s-params"
            rows={5}
            value={paramsText}
            onChange={(e) => {
              setParamsText(e.target.value);
            }}
            spellCheck={false}
          />
          <span className="hint">
            Validated against the strategy&apos;s own schema when it starts
            (plan/15 §4) — a bad param fails loudly at enable, never silently.
          </span>
        </div>

        {editing === null && (
          <div className="field-inline">
            <input
              id="s-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
              }}
            />
            <label htmlFor="s-enabled">Enable immediately</label>
          </div>
        )}

        {error !== null && <p className="login-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={save.isPending || name.length === 0}
            onClick={() => {
              setError(null);
              save.mutate();
            }}
          >
            {save.isPending
              ? "Saving…"
              : editing !== null
                ? "Save changes"
                : "Create strategy"}
          </button>
        </div>
      </div>
    </div>
  );
}
