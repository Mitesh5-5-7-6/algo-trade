"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { LevelBar, useNow } from "@/components/level-bar";
import { StepUpDialog } from "@/components/step-up-dialog";
import { api, isStepUpRequired } from "@/lib/api-client";
import { useDashboardData } from "@/lib/live";
import { formatIN, formatSignedINR, formatTimeIST } from "@/lib/format";
import { age, bareSymbol, price } from "@/lib/trade-card";

/** A price older than this, while the market is open, means the feed has lost it. */
const STALE_MS = 120_000;

type LivePosition = ReturnType<
  typeof useDashboardData
>["snapshot"]["positions"][number] & { ltp?: number; ltpAt?: number };

/**
 * Positions — live holdings with the last price the feed delivered, how old
 * it is, and where it sits between stop and target (2026-11-20). A price that
 * has stopped arriving is shown in red: that is a position whose exits cannot
 * fire (the four option positions of 2026-11-19).
 */
export default function PositionsPage() {
  const { snapshot } = useDashboardData();
  const { strategies } = snapshot;
  const marketOpen = snapshot.status.market.phase === "open";
  const positions = snapshot.positions as LivePosition[];
  const now = useNow();
  const strategyName = (id: string) =>
    strategies.find((s) => s.config.strategyId === id)?.config.name ?? id;
  const total = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

  // Manual exit (2026-11-25): the API's step-up exit, given a button.
  const [exiting, setExiting] = useState<LivePosition | null>(null);
  const [exitError, setExitError] = useState<string | null>(null);
  const [exitSent, setExitSent] = useState<string | null>(null);
  const exit = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      api.exitPosition(id, password),
    onSuccess: (_answer, { id }) => {
      setExitSent(id);
      setExiting(null);
      setExitError(null);
    },
    onError: (err: unknown) => {
      setExitError(
        isStepUpRequired(err)
          ? "Confirmation failed — wrong password?"
          : err instanceof Error
            ? err.message
            : "The exit was not sent.",
      );
    },
  });

  return (
    <>
      <h1 className="page-title">Positions</h1>
      <div className="cards" style={{ marginBottom: 16 }}>
        <div className="panel">
          <p className="panel-title">Open</p>
          <span className="kpi-value mono">{positions.length}</span>
        </div>
        <div className="panel">
          <p className="panel-title">Unrealized (live)</p>
          <span
            className={`kpi-value mono ${total < 0 ? "neg" : total > 0 ? "pos" : ""}`}
          >
            {formatSignedINR(total)}
          </span>
        </div>
      </div>
      <div className="panel">
        {positions.length === 0 ? (
          <p className="hint">No open positions.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Strategy</th>
                <th>Side</th>
                <th className="num">Qty</th>
                <th className="num">Avg entry</th>
                <th className="num">Live price</th>
                <th>Stop → target</th>
                <th className="num">Unrealized</th>
                <th>Opened</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => {
                const stale =
                  marketOpen &&
                  (position.ltpAt === undefined ||
                    now - position.ltpAt > STALE_MS);
                return (
                  <tr key={position.positionId}>
                    <td className="mono">{bareSymbol(position.symbol)}</td>
                    <td>{strategyName(position.strategyId)}</td>
                    <td>
                      <span
                        className={position.side === "LONG" ? "pos" : "neg"}
                        style={{ fontWeight: 700 }}
                      >
                        {position.side}
                      </span>
                    </td>
                    <td className="num">{formatIN(position.qty)}</td>
                    <td className="num">{position.avgEntryPrice.toFixed(2)}</td>
                    <td className="num">
                      <span className="mono live-price">
                        {price(position.ltp ?? null)}
                      </span>
                      <div className={`price-age ${stale ? "neg" : "hint"}`}>
                        {stale ? "⚠ " : ""}
                        {age(position.ltpAt, now)}
                      </div>
                    </td>
                    <td style={{ minWidth: 180 }}>
                      <LevelBar
                        stop={position.stopLoss}
                        entry={position.avgEntryPrice}
                        target={position.target}
                        ltp={position.ltp}
                      />
                    </td>
                    <td
                      className={`num ${position.unrealizedPnl < 0 ? "neg" : position.unrealizedPnl > 0 ? "pos" : ""}`}
                    >
                      {formatSignedINR(position.unrealizedPnl)}
                    </td>
                    <td className="mono">
                      {formatTimeIST(position.openedAt, false)}
                    </td>
                    <td>
                      {exitSent === position.positionId ? (
                        <span className="hint">Exit sent…</span>
                      ) : (
                        <button
                          type="button"
                          className="btn-danger-confirm"
                          onClick={() => {
                            setExitError(null);
                            setExiting(position);
                          }}
                        >
                          {position.side === "LONG" ? "Sell now" : "Buy back now"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="hint" style={{ marginTop: 8 }}>
          Refreshes every 5 seconds. A red price age means no price has arrived
          for that contract for over two minutes during the session — its stop
          and target cannot be judged until it does.
        </p>
      </div>
      {exiting !== null && (
        <StepUpDialog
          title={`exit ${bareSymbol(exiting.symbol)}`}
          copy={`${exiting.side === "LONG" ? "Sells" : "Buys back"} all ${formatIN(exiting.qty)} at market now, recorded as a manual exit. A contract with no live price cannot be exited this way. Re-enter your password to confirm.`}
          busy={exit.isPending}
          error={exitError}
          onConfirm={(password) => {
            exit.mutate({ id: exiting.positionId, password });
          }}
          onCancel={() => {
            setExiting(null);
            setExitError(null);
          }}
        />
      )}
    </>
  );
}
