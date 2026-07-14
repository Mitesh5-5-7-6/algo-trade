/**
 * Typed domain errors (plan/05 §5, plan/25 §5). Services throw these, never a
 * bare `new Error("oops")`; the central handler (server.ts) maps each to the
 * right HTTP status and logs it with context. Errors carry a context object,
 * not an interpolated string, so logs stay structured (plan/23 §3).
 *
 * The money-critical distinction (plan/05 §5): these are for the *control
 * plane* (job 2 — operator requests). A failure in the trading *pipeline*
 * (job 1) is never an HTTP error — it emits SYSTEM_ERROR and degrades safely
 * (plan/02 §10), because there is no request to respond to.
 */
export abstract class DomainError extends Error {
  /** HTTP status the central handler maps this to. */
  abstract readonly statusCode: number;
  /** Stable machine-readable code for the response envelope. */
  abstract readonly code: string;
  /** Structured context for logging — never secrets (plan/23 §3, plan/24 §5). */
  readonly context: Record<string, unknown>;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.context = context;
  }
}

/** Input failed validation at the boundary (plan/04 §4). */
export class ValidationError extends DomainError {
  readonly statusCode = 400;
  readonly code = "VALIDATION_ERROR";
}

/** A referenced entity does not exist. */
export class NotFoundError extends DomainError {
  readonly statusCode = 404;
  readonly code = "NOT_FOUND";
}

/** The request is not authenticated (plan/21). */
export class UnauthorizedError extends DomainError {
  readonly statusCode = 401;
  readonly code = "UNAUTHORIZED";
}

/** A dangerous action requires step-up re-auth (plan/21 §5). */
export class StepUpRequiredError extends DomainError {
  readonly statusCode = 403;
  readonly code = "STEP_UP_REQUIRED";
}

/** Too many login attempts — the account or IP is locked out (plan/21 §2). */
export class RateLimitError extends DomainError {
  readonly statusCode = 429;
  readonly code = "RATE_LIMITED";
}

/** A control-plane action violated a risk rule (plan/05 §5). */
export class RiskViolationError extends DomainError {
  readonly statusCode = 422;
  readonly code = "RISK_VIOLATION";
}

/** The broker layer reported a failure surfaced through the control plane. */
export class BrokerError extends DomainError {
  readonly statusCode = 502;
  readonly code = "BROKER_ERROR";
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
