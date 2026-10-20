// @regent-protocol/control-sdk — public API surface

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
  GatewayInput,
  GatewayResponse,
} from './types.js';
export { generateAgentKey, kidFor, proofOfPossession, loadOrCreateKey, readKeyFile, writeCredentials } from './agentkey.js';
export type { AgentKey } from './agentkey.js';
export { signRequest, contentDigest, authorityOf, signatureBase } from './httpsig.js';
export { Agentcard, AGENTCARD_SHOP, AGENTCARD_BUY } from './agentcard.js';
export type { AgentcardAsk, AgentcardCart, AgentcardItem, AgentcardOrder } from './agentcard.js';
