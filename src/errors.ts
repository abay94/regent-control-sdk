import type { DecisionCode } from './types.js';

/** Base error for transport/auth/validation failures (NOT a policy deny — that's a normal result). */
export class ControlError extends Error {
  readonly statusCode: number | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, opts: { statusCode?: number; requestId?: string } = {}) {
    super(message);
    this.name = 'ControlError';
    this.statusCode = opts.statusCode;
    this.requestId = opts.requestId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when the request never reached the control plane (timeout, DNS, refused). */
export class ControlNetworkError extends ControlError {
  readonly cause: Error | undefined;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'ControlNetworkError';
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Convenience error a caller can throw when a decision is not `allow`.
 * The SDK never throws this itself — `authorize()` returns the decision; the
 * caller decides whether a deny/escalate is exceptional in their flow.
 */
export class ControlDenied extends Error {
  readonly code: DecisionCode;
  readonly decisionId: string;

  constructor(code: DecisionCode, reason: string, decisionId: string) {
    super(reason);
    this.name = 'ControlDenied';
    this.code = code;
    this.decisionId = decisionId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
