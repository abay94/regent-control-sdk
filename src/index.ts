// @regent/control-sdk — public API surface

export { RegentControl } from './client.js';
export { deriveAgentSecret } from './crypto.js';
export { ControlError, ControlNetworkError, ControlDenied } from './errors.js';
export type {
  RegentControlConfig,
  AuthorizeInput,
  AuthorizeContext,
  Decision,
  AllowDecision,
  DenyDecision,
  EscalateDecision,
  DecisionCode,
  Obligation,
  Escalation,
  CompleteInput,
  CompleteResult,
  CompleteStatus,
} from './types.js';
