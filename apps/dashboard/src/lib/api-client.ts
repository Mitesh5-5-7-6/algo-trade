import type { Order, Position, StrategyConfig } from "@neelkanth/core";
import { API_BASE } from "./config";

/**
 * The REST half of the two data channels (plan/06 §5): request/response for
 * config, history, and control actions — the operator needs a confirmed result.
 * Live state arrives over the socket instead. Every call sends the session
 * cookie (`credentials: "include"`); a non-2xx becomes a typed {@link ApiError}
 * so callers can branch on 401 (→ login) vs the rest.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch {
      // non-JSON body — keep the status text
    }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** The `/pnl` read model (plan/05 §4.1). */
export interface PnlSummary {
  realizedPnl: number;
  unrealizedPnl: number;
}

/** The `/settings` document the operator tunes (plan/07 `settings`). */
export interface LiveSettings {
  capitalAllocation: number;
  tradingEnabled: boolean;
  globalRiskLimits: {
    maxDailyLoss: number;
    maxPositionSize: number;
    maxCapitalPerTrade: number;
    maxOpenPositions: number;
    maxExposure: number;
  };
  marketHours: { open: string; close: string; squareOff: string };
}

/** The `/control/status` snapshot (plan/05 §4.1). */
export interface ControlStatus {
  tradingEnabled: boolean;
  session: { phase: string; minutesSinceOpen: number };
  openPositions: number;
}

export const api = {
  login: (email: string, password: string) =>
    apiFetch<{ userId: string; email: string; role: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => apiFetch<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  positions: () => apiFetch<Position[]>("/positions"),
  orders: () => apiFetch<Order[]>("/orders"),
  strategies: () => apiFetch<StrategyConfig[]>("/strategies"),
  settings: () => apiFetch<LiveSettings>("/settings"),
  pnl: () => apiFetch<PnlSummary>("/pnl"),
  controlStatus: () => apiFetch<ControlStatus>("/control/status"),

  pause: () =>
    apiFetch<{ tradingEnabled: boolean }>("/control/pause", { method: "POST" }),
  kill: () =>
    apiFetch<{ killed: boolean }>("/control/kill", { method: "POST" }),
  /** ⚠ step-up: resume requires the operator's password (plan/21 §5). */
  resume: (stepUpPassword: string) =>
    apiFetch<{ tradingEnabled: boolean }>("/control/resume", {
      method: "POST",
      body: JSON.stringify({ stepUpPassword }),
    }),
};
