import type { Db } from "mongodb";
import type { CandleInterval } from "@neelkanth/core";
import {
  AgentAnswersRepository,
  ResearchReportsRepository,
  type AgentAnswerDoc,
} from "@neelkanth/db";
import type { AttributionModel } from "../counterfactual/attribution.js";
import type { RegimeModel } from "../counterfactual/regime.js";
import type { CounterfactualRun } from "../counterfactual/run.js";
import { counterfactualFromStore } from "../counterfactual/store.js";
import { SubmittedAnswerSchema } from "../agent/answer.js";
import { paramsOf, type Proposal } from "../agent/proposal.js";
import { auditAnswer } from "../agent/store.js";
import { pinsFor, type Hypothesis } from "./hypothesis.js";
import { nextId, registerHypothesis } from "./store.js";

/** Policy, not the model's choice (Phase 12 D1, D4). */
export const PROPOSAL_ALPHA = 0.05;
export const PROPOSAL_MIN_SAMPLE = 30;

/** What the operator decides at registration (D4). */
export interface RegisterProposalsRequest {
  answerId: string;
  /** The operator's window — it must start after the answer's asOf (D2). */
  outOfSample: { fromDate: string; toDate: string };
  /** 1-based proposal numbers; every proposal when absent. */
  pick?: number[];
  run: Pick<
    Hypothesis["run"],
    "interval" | "hours" | "allocatedCapital" | "limits" | "seed"
  >;
  /** The indices the run reads besides the instruments — the regime index among them. */
  indexSymbols: string[];
  regime: RegimeModel;
  attribution: AttributionModel;
  registeredAt: number;
}

export type ProposalRegistration =
  | { proposal: number; registered: Hypothesis }
  | { proposal: number; refused: string };

/** The family an answer's proposals are corrected within (D4). */
export const familyOf = (answerId: string): string => `P-${answerId}`;

/**
 * Register the proposals of a kept answer as hypotheses — the operator's act,
 * never the agent's (Phase 12 D4). Refused outright unless the answer is
 * kept, intact, SUPPORTED and carries proposals, and the out-of-sample window
 * starts after the answer's asOf (D2). Each picked proposal is then registered
 * — its in-sample window everything the agent could see, up to asOf; alpha and
 * minSample by policy; pins from an in-sample run under its own parameters —
 * or refused with why (a claim already registered). Nothing here creates,
 * changes or enables a strategy (D5).
 */
export async function registerProposals(
  db: Db,
  request: RegisterProposalsRequest,
): Promise<ProposalRegistration[]> {
  const doc = await new AgentAnswersRepository(db).findById(request.answerId);
  if (doc === null) throw new Error(`no kept answer ${request.answerId}`);
  const answer = usableAnswer(doc);
  const { outOfSample } = request;
  if (outOfSample.fromDate <= doc.asOf)
    throw new Error(
      `the out-of-sample window must start after ${doc.asOf}, the date the agent saw up to — ${outOfSample.fromDate} does not (Phase 12 D2)`,
    );
  if (outOfSample.toDate < outOfSample.fromDate)
    throw new Error("the out-of-sample window ends before it starts");
  const proposals = answer.proposals ?? [];
  const picked = request.pick ?? proposals.map((_, i) => i + 1);
  for (const n of picked)
    if (!Number.isInteger(n) || n < 1 || n > proposals.length)
      throw new Error(
        `there is no proposal ${String(n)} — the answer carries ${String(proposals.length)}`,
      );

  // What the agent could see: every researched session up to its asOf (D2).
  const seen = await new ResearchReportsRepository(db).latestInRange(
    "DAY",
    "0001-01-01",
    doc.asOf,
  );
  const first = seen.reduce<string | undefined>(
    (m, r) => (m === undefined || r.date < m ? r.date : m),
    undefined,
  );
  if (first === undefined)
    throw new Error(
      `no research up to ${doc.asOf}: nothing was seen to propose from`,
    );
  const inSample = { fromDate: first, toDate: doc.asOf };
  const symbols = doc.catalog?.symbols ?? [];
  if (symbols.length === 0)
    throw new Error(`${request.answerId} kept no catalog of instruments`);

  const runs = new Map<string, Promise<CounterfactualRun>>();
  const formedOn = (params: Record<string, Record<string, unknown>>) => {
    const key = JSON.stringify(params);
    let run = runs.get(key);
    if (run === undefined) {
      run = counterfactualFromStore(db, {
        symbols,
        indexSymbols: request.indexSymbols,
        interval: request.run.interval as CandleInterval,
        fromDate: inSample.fromDate,
        toDate: inSample.toDate,
        hours: request.run.hours,
        allocatedCapital: request.run.allocatedCapital,
        limits: request.run.limits,
        seed: request.run.seed,
        regime: request.regime,
        attribution: request.attribution,
        ...(Object.keys(params).length === 0 ? {} : { strategyParams: params }),
        experimentId: "unkept",
        createdAt: 0,
        save: false,
      }).then((r) => r.run);
      runs.set(key, run);
    }
    return run;
  };

  const out: ProposalRegistration[] = [];
  for (const n of picked) {
    const p = proposals[n - 1] as Proposal;
    const variant = paramsOf(p);
    const strategyParams =
      p.strategyParams.length === 0 ? {} : { [p.cell.strategyType]: variant };
    try {
      const run = await formedOn(strategyParams);
      const h = await registerHypothesis(db, {
        hypothesisId: await nextId(db),
        family: familyOf(request.answerId),
        statement: p.statement,
        cell: p.cell,
        metric: p.metric,
        direction: p.direction,
        threshold: p.threshold,
        alpha: PROPOSAL_ALPHA,
        minSample: PROPOSAL_MIN_SAMPLE,
        inSample,
        outOfSample,
        run: {
          symbols,
          indexSymbols: request.indexSymbols,
          ...request.run,
          ...(Object.keys(strategyParams).length === 0
            ? {}
            : { strategyParams }),
        },
        pins: pinsFor(run.manifest, p.cell),
        registeredAt: request.registeredAt,
        proposedBy: { answerId: request.answerId, proposal: n },
      });
      out.push({ proposal: n, registered: h });
    } catch (e) {
      out.push({
        proposal: n,
        refused: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

/**
 * The answer, if its proposals may be registered (D4): kept intact — the
 * audit holds — and SUPPORTED, which an answer is only when every proposal in
 * it passed its checks.
 */
function usableAnswer(doc: AgentAnswerDoc) {
  const audit = auditAnswer(doc);
  if (!audit.intact || !audit.verdictHolds || !audit.renderedHolds)
    throw new Error(
      `${doc.answerId} does not audit (fingerprint ${audit.intact ? "ok" : "changed"}, verdict ${audit.verdictHolds ? "ok" : "differs"}, text ${audit.renderedHolds ? "ok" : "differs"}) — its proposals cannot be registered`,
    );
  if (doc.verdict !== "SUPPORTED")
    throw new Error(
      `${doc.answerId} is ${doc.verdict}: only a SUPPORTED answer's proposals can be registered`,
    );
  const answer = SubmittedAnswerSchema.parse(doc.answer);
  if ((answer.proposals ?? []).length === 0)
    throw new Error(`${doc.answerId} carries no proposals`);
  return answer;
}
