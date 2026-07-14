import { qk, type QueryKey } from "./query-keys";

/**
 * The socket→cache reconciliation (plan/06 §5): when a live event arrives, it
 * invalidates the Query entries it could have changed, and TanStack Query
 * refetches the authoritative snapshot over REST. This keeps one source of
 * truth per view instead of patching cached shapes by hand — simpler and
 * immune to a socket payload and a REST payload drifting apart.
 *
 * The events forwarded by the bridge (plan/10 §5); a pure function so it is
 * unit-tested without a socket.
 */
export const FORWARDED_EVENTS = [
  "ORDER_PLACED",
  "ORDER_FILLED",
  "POSITION_UPDATED",
  "PNL_UPDATED",
  "SIGNAL_CREATED",
  "RISK_BLOCKED",
  "BROKER_CONNECTED",
  "BROKER_DISCONNECTED",
  "MARKET_OPEN",
  "MARKET_CLOSE",
  "SYSTEM_ERROR",
] as const;

export function queryKeysForEvent(event: string): readonly QueryKey[] {
  switch (event) {
    case "ORDER_PLACED":
    case "ORDER_FILLED":
      return [qk.orders, qk.positions, qk.pnl];
    case "POSITION_UPDATED":
      return [qk.positions, qk.pnl];
    case "PNL_UPDATED":
      return [qk.pnl];
    case "MARKET_OPEN":
    case "MARKET_CLOSE":
    case "BROKER_CONNECTED":
    case "BROKER_DISCONNECTED":
      return [qk.controlStatus];
    // SIGNAL_CREATED / RISK_BLOCKED / SYSTEM_ERROR feed the activity view,
    // which has no cached read model yet (mock-filled) — nothing to invalidate.
    default:
      return [];
  }
}
