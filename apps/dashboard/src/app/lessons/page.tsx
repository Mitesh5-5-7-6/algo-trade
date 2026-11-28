"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Lesson, LessonStats } from "@neelkanth/core";
import { api, ApiError } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { StepUpDialog } from "@/components/step-up-dialog";

/**
 * Lessons (PLAN.md 14.28, operator decision 2026-11-28, option A).
 *
 * The learning system tests a fixed menu of lessons — "skip a call when most
 * heavyweight stocks are down" — on past signals, each judged on months it did
 * not learn from. A lesson that passes is shown here; it changes nothing until
 * the operator applies it, behind the password. Applied lessons block paper
 * entries only, and each shows what it has done since.
 */

const pct = (x: number | null) =>
  x === null ? "—" : `${Math.round(x * 100)}%`;
const pf = (x: number | null) => (x === null ? "—" : x.toFixed(2));
const rupees = (x: number) =>
  `${x < 0 ? "−" : ""}₹${Math.abs(Math.round(x)).toLocaleString("en-IN")}`;

function StatsCell({ s }: { s: LessonStats }) {
  return (
    <span>
      {s.n} trades · win {pct(s.winRate)} · PF{" "}
      <span
        className={
          s.profitFactor !== null && s.profitFactor >= 1 ? "pos" : "neg"
        }
      >
        {pf(s.profitFactor)}
      </span>
    </span>
  );
}

const VERDICT_LABEL: Record<Lesson["verdict"], string> = {
  PASSED: "Passed",
  FAILED: "Failed",
  WAITING_FOR_DATA: "Waiting for data",
};

export default function LessonsPage() {
  const queryClient = useQueryClient();
  const lessons = useQuery({
    queryKey: qk.lessons,
    queryFn: api.lessons,
    refetchInterval: 60_000,
  });
  const [pending, setPending] = useState<{
    id: string;
    action: "apply" | "stop";
    summary: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: ({
      id,
      action,
      password,
    }: {
      id: string;
      action: "apply" | "stop";
      password: string;
    }) =>
      action === "apply"
        ? api.applyLesson(id, password)
        : api.stopLesson(id, password),
    onSuccess: async () => {
      setPending(null);
      setError(null);
      await queryClient.invalidateQueries({ queryKey: qk.lessons });
    },
    onError: (e: unknown) => {
      setError(e instanceof ApiError ? e.message : "the request failed");
    },
  });

  const data = lessons.data;
  const active = new Set(
    (data?.applied ?? [])
      .filter((a) => a.status === "ACTIVE")
      .map((a) => a.lessonId),
  );
  const groups = (["PASSED", "FAILED", "WAITING_FOR_DATA"] as const).map(
    (verdict) => ({
      verdict,
      rows: (data?.lessons ?? []).filter((l) => l.verdict === verdict),
    }),
  );
  const judged = data?.lessons[0];

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Lessons</h1>
      </div>

      <section className="panel" style={{ marginBottom: 16 }}>
        <p className="panel-title">How this works</p>
        <p className="panel-subtitle">
          Every weekday after the close, the system replays the Momentum
          rule&apos;s past signals and tests each lesson on the menu: first on
          the earlier 60% of days, then again on the later 40% it never learned
          from. A lesson passes only if it helps in both and the difference is
          unlikely to be luck, after allowing for every lesson tried. Nothing
          changes until you apply one; an applied lesson blocks paper entries
          only, and you can stop it any time.
        </p>
        {judged !== undefined && (
          <p className="panel-subtitle">
            Last judged on {judged.data.sessions} sessions ({judged.data.from} →{" "}
            {judged.data.to}), costs {judged.data.costPct}% a trade plus{" "}
            {judged.data.decayPctPerHour}% an hour of time decay.
          </p>
        )}
        {data?.researchError != null && (
          <p className="login-error">
            The research service did not answer: {data.researchError}
          </p>
        )}
        {lessons.isError && (
          <p className="login-error">Could not load lessons.</p>
        )}
      </section>

      {(data?.applied.length ?? 0) > 0 && (
        <section className="panel" style={{ marginBottom: 16 }}>
          <p className="panel-title">Applied to paper</p>
          <table className="data">
            <thead>
              <tr>
                <th>Lesson</th>
                <th>Since</th>
                <th className="num">Signals judged</th>
                <th className="num">Blocked</th>
                <th className="num">Taken → closed</th>
                <th className="num">Win rate</th>
                <th className="num">Net P&amp;L</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.applied.map((a) => (
                <tr key={a.lessonId}>
                  <td>
                    <span
                      className={`badge-status ${a.status === "ACTIVE" ? "on" : "off"}`}
                    >
                      {a.status}
                    </span>{" "}
                    {a.scope.underlying}: {a.summary}
                  </td>
                  <td>{new Date(a.appliedAt).toLocaleDateString("en-IN")}</td>
                  <td className="num">{a.forward.judged}</td>
                  <td className="num">{a.forward.blocked}</td>
                  <td className="num">
                    {a.forward.traded} → {a.forward.closed}
                  </td>
                  <td className="num">
                    {a.forward.closed === 0
                      ? "—"
                      : pct(a.forward.wins / a.forward.closed)}
                  </td>
                  <td
                    className={`num ${a.forward.netPnl >= 0 ? "pos" : "neg"}`}
                  >
                    {rupees(a.forward.netPnl)}
                  </td>
                  <td>
                    {a.status === "ACTIVE" && (
                      <button
                        type="button"
                        className="btn-ghost danger"
                        onClick={() => {
                          setError(null);
                          setPending({
                            id: a.lessonId,
                            action: "stop",
                            summary: a.summary,
                          });
                        }}
                      >
                        Stop
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {groups.map(({ verdict, rows }) =>
        rows.length === 0 ? null : (
          <section className="panel" style={{ marginBottom: 16 }} key={verdict}>
            <p className="panel-title">
              {VERDICT_LABEL[verdict]} ({rows.length})
            </p>
            <table className="data">
              <thead>
                <tr>
                  <th>Lesson</th>
                  {verdict !== "WAITING_FOR_DATA" && (
                    <th>Test period: all signals</th>
                  )}
                  {verdict !== "WAITING_FOR_DATA" && (
                    <th>Test period: kept by the lesson</th>
                  )}
                  <th>Why</th>
                  {verdict === "PASSED" && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.lessonId}>
                    <td>
                      <strong>{l.scope.underlying}</strong>: {l.summary}
                    </td>
                    {verdict !== "WAITING_FOR_DATA" && (
                      <td>
                        <StatsCell s={l.test.all} />
                      </td>
                    )}
                    {verdict !== "WAITING_FOR_DATA" && (
                      <td>
                        <StatsCell s={l.test.kept} />
                      </td>
                    )}
                    <td style={{ whiteSpace: "normal" }}>
                      {l.reasons.join("; ")}
                    </td>
                    {verdict === "PASSED" && (
                      <td>
                        {active.has(l.lessonId) ? (
                          <span className="badge-status on">APPLIED</span>
                        ) : (
                          <button
                            type="button"
                            className="btn-primary"
                            onClick={() => {
                              setError(null);
                              setPending({
                                id: l.lessonId,
                                action: "apply",
                                summary: l.summary,
                              });
                            }}
                          >
                            Apply to paper
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ),
      )}

      {data !== undefined &&
        data.lessons.length === 0 &&
        data.researchError === null && (
          <section className="panel">
            <p className="panel-subtitle">
              No lessons judged yet. The first run happens when the research
              service starts.
            </p>
          </section>
        )}

      {pending !== null && (
        <StepUpDialog
          title={
            pending.action === "apply"
              ? "apply this lesson to paper"
              : "stop this lesson"
          }
          copy={
            pending.action === "apply"
              ? `From now on, paper skips the entries this lesson blocks: "${pending.summary}". Re-enter your password to apply it.`
              : `Paper stops using this lesson: "${pending.summary}". Re-enter your password to stop it.`
          }
          busy={act.isPending}
          error={error}
          onConfirm={(password) => {
            act.mutate({ id: pending.id, action: pending.action, password });
          }}
          onCancel={() => {
            setPending(null);
            setError(null);
          }}
        />
      )}
    </div>
  );
}
