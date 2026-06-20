// Public types — the camelCase TS surface over the Decision API wire contract
// (regent-control-openapi.yaml). The SDK translates to/from snake_case at the edge.

export type DecisionCode =
  | 'IDENTITY_NOT_RESOLVED'
  | 'AGENT_NOT_ACTIVE'
  | 'POLICY_DENIED'
  | 'TOOL_NOT_ALLOWED'
  | 'MANDATE_NOT_FOUND'
  | 'MANDATE_LIMIT_EXCEEDED'
  | 'RISK_THRESHOLD_EXCEEDED'
  | 'ESCALATION_REQUIRED'
  | 'INTERNAL_ERROR';

export interface AuthorizeContext {
  sessionId?: string;
  userRef?: string;
  ip?: string;
  chain?: string;
  amountUsd?: number;
  mandateId?: string;
  idempotencyKey?: string;
  /** The human's OIDC id_token, when acting on a person's behalf. Gate-verified. */
  userToken?: string;
  /** One-line justification — recorded in the audit, never trusted as enforcement. */
  intent?: string;
  /** Optional longer "how the agent reasoned" summary, recorded alongside intent. */
  reasoningSummary?: string;
  /** A task/ticket reference this action belongs to. */
  task?: string;
  /** Semantic operation, e.g. "refund.create" / "read" / "delete". */
  op?: string;
  /** Resource type the operation targets, e.g. "Contact" / "refund". */
  resourceType?: string;
  /** Verified account state the policy keys on, e.g. "active" / "frozen". */
  accountStatus?: string;
  /** Whether a refund returns to the original payment method. */
  refundToOriginal?: boolean;
  [key: string]: unknown;
}

export interface AuthorizeInput {
  tool: string;
  action: string;
  resource?: string;
  args?: Record<string, unknown>;
  context?: AuthorizeContext;
}

export interface Obligation {
  type: string;
  fields?: string[];
  [key: string]: unknown;
}

export interface Escalation {
  type: 'ciba' | 'manual' | 'webhook';
  approver?: string;
  ref: string;
  expiresAt?: string;
}

export interface AllowDecision {
  decision: 'allow';
  /** Convenience discriminant: true only for allow. */
  allowed: true;
  decisionId: string;
  /** Short-lived scoped JWT to attach to the downstream call. */
  token: string;
  expiresAt: string;
  riskScore?: number;
  obligations: Obligation[];
}

export interface DenyDecision {
  decision: 'deny';
  allowed: false;
  decisionId: string;
  code: DecisionCode;
  reason: string;
}

export interface EscalateDecision {
  decision: 'escalate';
  allowed: false;
  decisionId: string;
  code: DecisionCode;
  reason: string;
  escalation: Escalation;
}

export type Decision = AllowDecision | DenyDecision | EscalateDecision;

export type CompleteStatus = 'success' | 'failed' | 'aborted';

export interface CompleteInput {
  status: CompleteStatus;
  downstreamRef?: string;
  error?: string | null;
}

export interface CompleteResult {
  decisionId: string;
  recorded: boolean;
  mandateReconciled: boolean;
}

export interface RegentControlConfig {
  /** Organization API key (`rgnt_ctrl_...`). */
  apiKey: string;
  /** The agent this client governs. */
  agentId: string;
  /** Decision API base URL. Default: https://api.regentprotocol.org */
  baseUrl?: string;
  /** Optional per-agent HMAC secret; if set, requests are signed (X-Agent-Signature). */
  agentSecret?: string;
  /** Per-request timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /** Max retries on network / 429 / 5xx. Default 2. */
  maxRetries?: number;
}
