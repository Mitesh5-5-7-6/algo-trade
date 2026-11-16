"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import {
  describeVerdict,
  parseOddsForm,
  pct,
  points,
  r,
  type OddsForm,
  type OddsResponse,
} from "@/lib/odds";
import { qk } from "@/lib/query-keys";

/** The rules whose history the research data can replay (index bars only). */
const RULES = ["ORB", "EMA_CROSSOVER", "RSI"] as const;

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
 * Time Machine — the odds of one plan reaching its target before its stop
 * (plan §31; design §6). The page only asks and shows: every number is the
 * research service's, computed on the index's own bars, never an option's.
 */
export default function TimeMachinePage() {
  const [form, setForm] = useState<OddsForm>(() => ({
    symbol: "",
    side: "LONG",
    entry: "",
    stop: "",
    target: "",
    date: todayIST(),
    time: "10:05",
    ruleType: "",
    ruleParams: "",
    poolSessions: "",
  }));
  const [formError, setFormError] = useState<string | null>(null);
  const set = (field: keyof OddsForm) => (value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const coverage = useQuery({
    queryKey: qk.oddsCoverage,
    queryFn: api.oddsCoverage,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const stored = coverage.data ?? [];
  const symbol = form.symbol !== "" ? form.symbol : (stored[0]?.symbol ?? "");
  const held = stored.find((c) => c.symbol === symbol);

  const odds = useMutation({ mutationFn: api.runOdds });
  const run = () => {
    const parsed = parseOddsForm(
      { ...form, symbol },
      stored.map((c) => c.symbol),
    );
    if (!parsed.ok) {
      setFormError(parsed.error);
      return;
    }
    setFormError(null);
    odds.mutate(parsed.request);
  };

  return (
    <>
      <h1 className="page-title">Time Machine</h1>

      <section className="panel" style={{ marginBottom: 16 }}>
        <p className="panel-title">The plan</p>
        <p className="panel-subtitle">
          How often does the target come before the stop? Measured on the
          index&apos;s own 5-minute bars, in index points, before any cost — not
          an option&apos;s premium.
        </p>
        <div className="odds-form">
          <label className="filter-field">
            <span>Symbol</span>
            {stored.length > 0 ? (
              <select
                value={symbol}
                onChange={(event) => {
                  set("symbol")(event.target.value);
                }}
              >
                {stored.map((c) => (
                  <option key={c.symbol} value={c.symbol}>
                    {c.symbol}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={form.symbol}
                placeholder="NSE:NIFTYBANK-INDEX"
                onChange={(event) => {
                  set("symbol")(event.target.value);
                }}
              />
            )}
          </label>
          <label className="filter-field">
            <span>Side</span>
            <select
              value={form.side}
              onChange={(event) => {
                set("side")(event.target.value);
              }}
            >
              <option value="LONG">Long</option>
              <option value="SHORT">Short</option>
            </select>
          </label>
          {(["entry", "stop", "target"] as const).map((field) => (
            <label className="filter-field" key={field}>
              <span>{field}</span>
              <input
                type="number"
                inputMode="decimal"
                step="any"
                min="0"
                value={form[field]}
                onChange={(event) => {
                  set(field)(event.target.value);
                }}
              />
            </label>
          ))}
          <label className="filter-field">
            <span>Date</span>
            <input
              type="date"
              value={form.date}
              onChange={(event) => {
                set("date")(event.target.value);
              }}
            />
          </label>
          <label className="filter-field">
            <span>Time (IST)</span>
            <input
              type="time"
              min="09:20"
              max="15:25"
              value={form.time}
              onChange={(event) => {
                set("time")(event.target.value);
              }}
            />
          </label>
          <label className="filter-field">
            <span>Rule (for history)</span>
            <select
              value={form.ruleType}
              onChange={(event) => {
                set("ruleType")(event.target.value);
              }}
            >
              <option value="">None — replays only</option>
              {RULES.map((rule) => (
                <option key={rule} value={rule}>
                  {rule}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            <span>Sessions used</span>
            <input
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              placeholder="all"
              value={form.poolSessions}
              onChange={(event) => {
                set("poolSessions")(event.target.value);
              }}
            />
          </label>
        </div>
        {form.ruleType !== "" && (
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="odds-rule-params">Rule params (JSON)</label>
            <textarea
              id="odds-rule-params"
              rows={2}
              value={form.ruleParams}
              placeholder="{} — the rule's own defaults"
              spellCheck={false}
              onChange={(event) => {
                set("ruleParams")(event.target.value);
              }}
            />
          </div>
        )}
        <div className="odds-actions">
          <button
            type="button"
            className="btn-primary"
            disabled={odds.isPending}
            onClick={run}
          >
            {odds.isPending ? "Running…" : "Run the odds"}
          </button>
          <span className="hint">
            {coverage.isError
              ? `Research data unavailable: ${message(coverage.error)}`
              : held !== undefined
                ? `Stored bars: ${held.firstDate} to ${held.lastDate}. Only sessions before the plan's date are used.`
                : coverage.isPending
                  ? "Checking what the research data holds…"
                  : "No stored bars for this symbol."}
          </span>
        </div>
        {formError !== null && <p className="login-error">{formError}</p>}
        {odds.isError && <p className="login-error">{message(odds.error)}</p>}
      </section>

      {odds.data !== undefined && <OddsResult run={odds.data} />}
    </>
  );
}

function OddsResult({ run }: { run: OddsResponse }) {
  const { manifest, result } = run;
  const { resampled, resampledVerdict, history, historyVerdict } = result;
  const { pool } = manifest;
  const simulated = describeVerdict(resampledVerdict.verdict);
  const share = (count: number) =>
    pct(resampled.replays === 0 ? null : count / resampled.replays);

  return (
    <>
      <div className="cards">
        <div className="panel">
          <p className="panel-title">Target first</p>
          <span className="kpi-value mono">{share(resampled.targetFirst)}</span>
          <p className="kpi-sub">
            of {resampled.replays.toLocaleString("en-IN")} simulated replays
          </p>
        </div>
        <div className="panel">
          <p className="panel-title">Stop first</p>
          <span className="kpi-value mono">{share(resampled.stopFirst)}</span>
          <p className="kpi-sub">a bar touching both counts as the stop</p>
        </div>
        <div className="panel">
          <p className="panel-title">Neither by the close</p>
          <span className="kpi-value mono">{share(resampled.neither)}</span>
          <p className="kpi-sub">
            the plan pays {manifest.plan.targetR.toFixed(2)}R at its target
          </p>
        </div>
      </div>

      <section className="panel" style={{ marginBottom: 16 }}>
        <p className="panel-title">Simulated replays</p>
        <p className={`odds-verdict ${simulated.tone}`}>{simulated.label}</p>
        <table className="data odds-table">
          <tbody>
            <tr>
              <td>Target&apos;s share of decided replays</td>
              <td className="num mono">{pct(resampledVerdict.targetShare)}</td>
            </tr>
            <tr>
              <td>Break-even share, 1 / (1 + R)</td>
              <td className="num mono">{pct(resampledVerdict.breakEven)}</td>
            </tr>
            <tr>
              <td>Gap to break-even</td>
              <td className="num mono">
                {points(resampledVerdict.edgePoints)}
              </td>
            </tr>
            <tr>
              <td>Average result per replay</td>
              <td className="num mono">{r(resampled.averageR)}</td>
            </tr>
            <tr>
              <td>Stops reached through a gap (scored −1R, understated)</td>
              <td className="num mono">{resampled.gapThroughStop}</td>
            </tr>
            <tr>
              <td>Where the day closed, 5th to 95th percentile</td>
              <td className="num mono">
                {resampled.closeBands.p5.toFixed(2)} …{" "}
                {resampled.closeBands.p50.toFixed(2)} …{" "}
                {resampled.closeBands.p95.toFixed(2)}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="panel" style={{ marginBottom: 16 }}>
        <p className="panel-title">The rule&apos;s real history</p>
        {history === null || historyVerdict === null ? (
          <p className="hint">
            Not run — choose a rule to see how it did over the same sessions.
          </p>
        ) : (
          <>
            <p
              className={`odds-verdict ${describeVerdict(historyVerdict.verdict).tone}`}
            >
              {describeVerdict(historyVerdict.verdict).label}
            </p>
            <table className="data odds-table">
              <tbody>
                <tr>
                  <td>
                    {manifest.history?.rule.type} traded this side, over{" "}
                    {history.sessions} sessions
                  </td>
                  <td className="num mono">{history.fired} times</td>
                </tr>
                <tr>
                  <td>Target / stop / neither</td>
                  <td className="num mono">
                    {history.targetFirst} / {history.stopFirst} /{" "}
                    {history.neither}
                  </td>
                </tr>
                <tr>
                  <td>Average result of every trade (95% interval)</td>
                  <td className="num mono">
                    {r(historyVerdict.averageR)}
                    {historyVerdict.rInterval !== null &&
                      ` (${r(historyVerdict.rInterval.lower)} to ${r(historyVerdict.rInterval.upper)})`}
                  </td>
                </tr>
                <tr>
                  <td>Target&apos;s share of decided trades (95% interval)</td>
                  <td className="num mono">
                    {pct(historyVerdict.targetShare)}
                    {historyVerdict.shareInterval !== null &&
                      ` (${pct(historyVerdict.shareInterval.lower)} to ${pct(historyVerdict.shareInterval.upper)})`}
                  </td>
                </tr>
                <tr>
                  <td>Break-even of the rule&apos;s own targets</td>
                  <td className="num mono">{pct(historyVerdict.breakEven)}</td>
                </tr>
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className="panel">
        <p className="panel-title">What this does not tell you</p>
        <ul className="odds-notes">
          <li>
            These are the index&apos;s odds of reaching the levels. An
            option&apos;s premium also moves with time and volatility.
          </li>
          <li>R is before brokerage, taxes and slippage.</li>
          <li>
            Each simulated bar is drawn on its own, so a replayed day has no
            momentum or volatility clustering, and the replays are redraws from{" "}
            {pool.sessions} sessions — not{" "}
            {resampled.replays.toLocaleString("en-IN")} observations.
          </li>
          <li>
            The two methods are shown side by side and are never combined.
            Expiry days are not separated.
          </li>
        </ul>
        <p className="hint">
          Sessions {pool.dates[0] ?? "—"} to {pool.dates.at(-1) ?? "—"}
          {pool.excluded.length > 0 &&
            `; left out ${pool.excluded.map((e) => e.date).join(", ")}`}
          . Fingerprint{" "}
          <span className="mono">{run.fingerprint.slice(0, 12)}</span>
          {run.saved ? `, kept as ${run.experimentId ?? ""}` : ", not kept"}.
        </p>
      </section>
    </>
  );
}
