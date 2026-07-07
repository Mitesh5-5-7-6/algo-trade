/**
 * The health model (plan/23 §4): two probes with different meanings.
 *
 * - Liveness — "the process responds." Failure ⇒ the supervisor restarts it
 *   (plan/22 §2). It asks *nothing* about dependencies: a process that is
 *   alive but can't reach Redis must NOT be restart-looped, because a restart
 *   won't fix Redis.
 * - Readiness — "the process can do its job": Redis reachable, Mongo
 *   reachable (broker/session/queues join later as those subsystems land).
 *   Failure ⇒ report unready, halt new orders (plan/08 §11), and wait.
 *
 * Liveness answers "restart me?"; readiness answers "trust me?".
 */

export type DependencyState = "up" | "down";

export interface DependencyCheck {
  name: string;
  /** Resolves to whether the dependency answered; must never throw. */
  probe: () => Promise<boolean>;
}

export interface ReadinessReport {
  ready: boolean;
  dependencies: Record<string, DependencyState>;
}

/**
 * Run every dependency probe and aggregate. A probe that rejects is treated
 * as `down` (fail-closed, plan/14 §9) — an unverifiable dependency is a
 * dependency we do not trust. Probes run concurrently; one slow check does
 * not serialize the rest.
 */
export async function checkReadiness(
  checks: readonly DependencyCheck[],
): Promise<ReadinessReport> {
  const results = await Promise.all(
    checks.map(async (check): Promise<[string, DependencyState]> => {
      try {
        const ok = await check.probe();
        return [check.name, ok ? "up" : "down"];
      } catch {
        return [check.name, "down"];
      }
    }),
  );

  const dependencies: Record<string, DependencyState> = {};
  for (const [name, state] of results) {
    dependencies[name] = state;
  }

  return {
    ready: results.every(([, state]) => state === "up"),
    dependencies,
  };
}
