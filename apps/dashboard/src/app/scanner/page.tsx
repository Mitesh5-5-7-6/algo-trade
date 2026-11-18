"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import {
  barDate,
  describeHeld,
  describeReason,
  parseScanForm,
  type ScanResponse,
} from "@/lib/scan";

function todayIST(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

const message = (error: unknown): string =>
  error instanceof ApiError || error instanceof Error
    ? error.message
    : "The request failed.";

/**
 * Scanner — the pre-open F&O scan (plan §32; design §7). Every F&O
 * underlying judged on its last daily bar before the chosen day: candidates
 * with the conditions that held, every other one with its reason. The page
 * only asks and shows; the research service does the work.
 */
export default function ScannerPage() {
  const [form, setForm] = useState({
    date: todayIST(),
    minDaysToExpiry: "2",
  });
  const [formError, setFormError] = useState<string | null>(null);

  const coverage = useQuery({
    queryKey: qk.scanCoverage,
    queryFn: api.scanCoverage,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const stored = coverage.data ?? [];
  const latest = stored.reduce<string | null>(
    (max, c) => (max === null || c.lastDate > max ? c.lastDate : max),
    null,
  );

  const scan = useMutation({ mutationFn: api.runScan });
  const run = () => {
    const parsed = parseScanForm(form);
    if (!parsed.ok) {
      setFormError(parsed.error);
      return;
    }
    setFormError(null);
    scan.mutate(parsed.request);
  };

  return (
    <>
      <h1 className="page-title">Scanner</h1>

      <section className="panel" style={{ marginBottom: 16 }}>
        <p className="panel-title">Pre-open scan</p>
        <p className="panel-subtitle">
          Every F&amp;O underlying, judged on its last daily bar before the day
          you choose. Candidates to look at, never signals to trade.
        </p>
        <div className="odds-form">
          <label className="filter-field">
            <span>Scan for</span>
            <input
              type="date"
              value={form.date}
              onChange={(event) => {
                setForm((f) => ({ ...f, date: event.target.value }));
              }}
            />
          </label>
          <label className="filter-field">
            <span>Min. days to expiry</span>
            <input
              type="number"
              inputMode="numeric"
              min="0"
              max="30"
              step="1"
              value={form.minDaysToExpiry}
              onChange={(event) => {
                setForm((f) => ({ ...f, minDaysToExpiry: event.target.value }));
              }}
            />
          </label>
        </div>
        <div className="odds-actions">
          <button
            type="button"
            className="btn-primary"
            disabled={scan.isPending}
            onClick={run}
          >
            {scan.isPending ? "Scanning…" : "Run the scan"}
          </button>
          <span className="hint">
            {coverage.isError
              ? `Research data unavailable: ${message(coverage.error)}`
              : coverage.isPending
                ? "Checking what the research data holds…"
                : latest === null
                  ? "No daily bars stored yet."
                  : `Daily bars stored for ${String(stored.length)} symbols, the latest ${latest}. A scan judges the last trading day before the date chosen.`}
          </span>
        </div>
        {formError !== null && <p className="login-error">{formError}</p>}
        {scan.isError && <p className="login-error">{message(scan.error)}</p>}
      </section>

      {scan.data !== undefined && <ScanResult run={scan.data} />}
    </>
  );
}

function ScanResult({ run }: { run: ScanResponse }) {
  const { result } = run;
  const [showAll, setShowAll] = useState(false);
  const n = result.counts.rejected;
  const notable = result.rejected.filter(
    (x) => showAll || x.reason !== "NO_CONDITION",
  );

  return (
    <>
      <div className="cards">
        <div className="panel">
          <p className="panel-title">Candidates</p>
          <span className="kpi-value mono">{result.counts.candidates}</span>
          <p className="kpi-sub">
            of {result.counts.members} underlyings, on the bars of{" "}
            {result.dataDate}
          </p>
        </div>
        <div className="panel">
          <p className="panel-title">No condition held</p>
          <span className="kpi-value mono">{n.NO_CONDITION}</span>
          <p className="kpi-sub">judged, and passed over</p>
        </div>
        <div className="panel">
          <p className="panel-title">Not judged</p>
          <span className="kpi-value mono">
            {n.NOT_JUDGEABLE + n.STALE_DATA + n.NO_BARS}
          </span>
          <p className="kpi-sub">
            {n.NO_BARS} no bars, {n.STALE_DATA} not current, {n.NOT_JUDGEABLE}{" "}
            too little history
          </p>
        </div>
      </div>

      <section className="panel" style={{ marginBottom: 16 }}>
        <p className="panel-title">
          {result.status === "PARTIAL" ? "Partial scan" : "Complete scan"}
        </p>
        <ul className="odds-notes">
          {result.partialBecause.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </section>

      <section className="panel" style={{ marginBottom: 16 }}>
        <p className="panel-title">Candidates</p>
        {result.candidates.length === 0 ? (
          <p className="hint">
            No condition held on any underlying&apos;s bar of {result.dataDate}.
          </p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Underlying</th>
                <th>Bias</th>
                <th className="num">Close</th>
                <th>Future · lot</th>
                <th>What held</th>
              </tr>
            </thead>
            <tbody>
              {result.candidates.map((c) => (
                <tr key={c.underlying}>
                  <td>{c.underlying}</td>
                  <td>
                    <span
                      className={
                        c.bias === "BULLISH"
                          ? "pos"
                          : c.bias === "BEARISH"
                            ? "neg"
                            : undefined
                      }
                    >
                      {c.bias.toLowerCase()}
                    </span>
                  </td>
                  <td className="num mono">{c.close.toFixed(2)}</td>
                  <td className="mono">
                    {c.future} · {c.lotSize}
                  </td>
                  <td>
                    {c.held.map((h) => (
                      <div key={h.patternId}>{describeHeld(h)}</div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel" style={{ marginBottom: 16 }}>
        <p className="panel-title">Passed over</p>
        <label className="hint" style={{ display: "block", marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={showAll}
            onChange={(event) => {
              setShowAll(event.target.checked);
            }}
          />{" "}
          Also list the {n.NO_CONDITION} on which no condition held
        </label>
        {notable.length === 0 ? (
          <p className="hint">Every underlying was judged on current data.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Underlying</th>
                <th>Why</th>
                <th>Bar</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {notable.map((x) => (
                <tr key={x.underlying}>
                  <td>{x.underlying}</td>
                  <td>{describeReason(x.reason)}</td>
                  <td className="mono">{barDate(x.dataTime)}</td>
                  <td className="hint">{x.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {result.universeRejected.length > 0 && (
          <p className="hint">
            Not in the universe:{" "}
            {result.universeRejected
              .map((u) => `${u.underlying} (${u.detail})`)
              .join("; ")}
            .
          </p>
        )}
      </section>

      <section className="panel">
        <p className="panel-title">What this does not tell you</p>
        <ul className="odds-notes">
          <li>
            A candidate is a structure that completed at the close of{" "}
            {result.dataDate}. It has no entry, stop or size, and must still
            pass a strategy&apos;s own rules and the Risk Engine.
          </li>
          <li>
            The F&amp;O ban list, open interest and price bands are not checked
            yet.
          </li>
          {result.conditions.map((c) => (
            <li key={c.patternId}>
              <strong>{c.patternId}</strong> — {c.definition}
            </li>
          ))}
        </ul>
        <p className="hint">
          Fingerprint{" "}
          <span className="mono">{run.fingerprint.slice(0, 12)}</span>
          {run.saved ? `, kept as ${run.experimentId ?? ""}` : ", not kept"}.
        </p>
      </section>
    </>
  );
}
