import type { Db } from "mongodb";
import { StrategyConfigSchema, type StrategyConfig } from "@neelkanth/core";
import { StrategiesRepository } from "@neelkanth/db";
import { createStrategyRegistry } from "@neelkanth/strategies";

/**
 * The Phase 14 test subject (design D1, Q3): ORB and EMA_CROSSOVER as
 * configured — defaults throughout — on NIFTY 50 and NIFTY BANK, which trade
 * often enough to exercise every path. Marked `subject`, with no candidate:
 * nothing its paper run shows makes it promotable.
 */
export const SUBJECT_SYMBOLS = ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX"];

const INDEX_SYMBOL = /^NSE:[A-Z0-9]+-INDEX$/;

const SUBJECT = [
  { strategyId: "subject_orb", type: "ORB", name: "Phase 14 subject — ORB" },
  {
    strategyId: "subject_ema_crossover",
    type: "EMA_CROSSOVER",
    name: "Phase 14 subject — EMA crossover",
  },
] as const;

/**
 * Write the subject's strategies into the paper database, enabled, unless
 * they are there already. A config already present is left exactly as it is:
 * provisioning twice must not quietly change what a run in progress decides.
 *
 * The running process enables strategies at boot; provision before starting
 * it (the runbook's order), or restart it.
 */
export async function provisionSubject(
  db: Db,
  options: { symbols?: string[]; now: number },
): Promise<{ created: StrategyConfig[]; existing: StrategyConfig[] }> {
  const repo = new StrategiesRepository(db);
  const registry = createStrategyRegistry();
  const symbols = options.symbols ?? SUBJECT_SYMBOLS;
  // The subject trades indices, sized as the replay sizes them (D1). Symbols
  // are free text everywhere else, so the shape is held here.
  const stray = symbols.find((s) => !INDEX_SYMBOL.test(s));
  if (stray !== undefined || symbols.length === 0)
    throw new Error(
      `the subject trades NSE indices only ("NSE:NAME-INDEX"); got ${stray ?? "no symbols"}`,
    );

  // Every config is built and checked before any is written, so a refusal
  // leaves the database as it was rather than half-provisioned. The registry
  // validates as enabling would: a subject that could never start is
  // refused here, not at the bell.
  const existing: StrategyConfig[] = [];
  const toCreate: StrategyConfig[] = [];
  for (const s of SUBJECT) {
    const kept = await repo.findById(s.strategyId);
    if (kept !== null) {
      existing.push(kept);
      continue;
    }
    for (const symbol of symbols) registry.instantiate(s.type, {}, symbol);
    toCreate.push(
      StrategyConfigSchema.parse({
        ...s,
        ownerId: "operator",
        params: {},
        symbols,
        enabled: true,
        status: "active",
        validation: { role: "subject" },
        createdAt: options.now,
        updatedAt: options.now,
      }),
    );
  }
  const created: StrategyConfig[] = [];
  for (const config of toCreate) created.push(await repo.create(config));
  return { created, existing };
}
