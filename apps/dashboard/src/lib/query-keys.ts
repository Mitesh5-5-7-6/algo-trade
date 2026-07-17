/**
 * TanStack Query keys — the single cache the two channels fill (plan/06 §5).
 * REST fetches seed each entry; socket events invalidate the right ones (see
 * event-map), so a component reads from one place regardless of source.
 */
export const qk = {
  positions: ["positions"] as const,
  orders: ["orders"] as const,
  activity: ["activity"] as const,
  strategies: ["strategies"] as const,
  strategyStats: ["strategies", "stats"] as const,
  strategyTypes: ["strategyTypes"] as const,
  settings: ["settings"] as const,
  pnl: ["pnl"] as const,
  // Deliberately NOT nested under "pnl": PNL_UPDATED invalidates qk.pnl on
  // every throttled tick, but the curve gains one point a minute — it refetches
  // on its own interval instead of riding that cascade.
  pnlCurve: ["pnlCurve"] as const,
  controlStatus: ["control", "status"] as const,
};

export type QueryKey = (typeof qk)[keyof typeof qk];
