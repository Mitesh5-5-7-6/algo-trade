/**
 * TanStack Query keys — the single cache the two channels fill (plan/06 §5).
 * REST fetches seed each entry; socket events invalidate the right ones (see
 * event-map), so a component reads from one place regardless of source.
 */
export const qk = {
  positions: ["positions"] as const,
  orders: ["orders"] as const,
  strategies: ["strategies"] as const,
  settings: ["settings"] as const,
  pnl: ["pnl"] as const,
  controlStatus: ["control", "status"] as const,
};

export type QueryKey = (typeof qk)[keyof typeof qk];
