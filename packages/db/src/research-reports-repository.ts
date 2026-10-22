import type { Db } from "mongodb";
import { z } from "zod";
import { COLLECTIONS } from "./collections.js";

/**
 * One research report, as kept (spec §6.1): daily, weekly, monthly and
 * quarterly research are ONE collection with a `period` field. The report's
 * body is the research's own shape; this repository keeps what it is queried
 * by at the top level and the rest as written.
 */
export const ResearchReportDocSchema = z.object({
  reportId: z.string().min(1),
  period: z.enum(["DAY"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  symbol: z.string().min(1),
  /** 1, then 2 when a revised bar forces a recomputation (spec §5.8). */
  version: z.number().int().positive(),
  generatedAt: z.number().int().nonnegative(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  /** The trading sessions it read — so a revised bar finds every report that read it. */
  sessions: z.array(z.string()).min(1),
  inputsFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  report: z.record(z.string(), z.unknown()),
});
export type ResearchReportDoc = z.infer<typeof ResearchReportDocSchema>;

/** `research_reports` — research evidence, untimed, never edited (ADR §10.4, spec §5.8). */
export class ResearchReportsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.researchReports);
  }

  /** Keep a report. Never overwrites: false when its id — and so its version — exists. */
  async save(report: ResearchReportDoc): Promise<boolean> {
    const doc = ResearchReportDocSchema.parse(report);
    const result = await this.collection.updateOne(
      { reportId: doc.reportId },
      { $setOnInsert: doc },
      { upsert: true },
    );
    return result.upsertedCount > 0;
  }

  /** The newest version of one report, or null. */
  async latest(
    period: "DAY",
    date: string,
    symbol: string,
  ): Promise<ResearchReportDoc | null> {
    const doc = await this.collection.findOne(
      { period, date, symbol },
      { projection: { _id: 0 }, sort: { version: -1 } },
    );
    return doc === null ? null : ResearchReportDocSchema.parse(doc);
  }

  /** The newest version of every report in `[fromDate, toDate]`, by date then symbol. */
  async latestInRange(
    period: "DAY",
    fromDate: string,
    toDate: string,
  ): Promise<ResearchReportDoc[]> {
    const docs = await this.collection
      .find(
        { period, date: { $gte: fromDate, $lte: toDate } },
        { projection: { _id: 0 } },
      )
      .sort({ date: 1, symbol: 1, version: -1 })
      .toArray();
    const seen = new Set<string>();
    const out: ResearchReportDoc[] = [];
    for (const d of docs.map((x) => ResearchReportDocSchema.parse(x))) {
      const key = `${d.date}|${d.symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
    return out;
  }

  /** The newest version of every report that read a session — what a revision of it reaches. */
  async latestReading(
    period: "DAY",
    session: string,
  ): Promise<ResearchReportDoc[]> {
    const docs = await this.collection
      .find({ period, sessions: session }, { projection: { _id: 0 } })
      .sort({ date: 1, symbol: 1, version: -1 })
      .toArray();
    const all = docs.map((x) => ResearchReportDocSchema.parse(x));
    const newest = new Map<string, ResearchReportDoc>();
    for (const d of all)
      if (!newest.has(`${d.date}|${d.symbol}`))
        newest.set(`${d.date}|${d.symbol}`, d);
    return [...newest.values()];
  }

  /** Every version of one report, oldest first. */
  async versions(
    period: "DAY",
    date: string,
    symbol: string,
  ): Promise<ResearchReportDoc[]> {
    const docs = await this.collection
      .find({ period, date, symbol }, { projection: { _id: 0 } })
      .sort({ version: 1 })
      .toArray();
    return docs.map((x) => ResearchReportDocSchema.parse(x));
  }
}
