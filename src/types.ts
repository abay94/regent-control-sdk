// Public types — the camelCase TS surface over the Decision API wire contract
// (regent-control-openapi.yaml). The SDK translates to/from snake_case at the edge.
import type { AgentKey } from './agentkey.js';

export type DecisionCode =
  | 'IDENTITY_NOT_RESOLVED'
  | 'AGENT_NOT_ACTIVE'
  | 'POLICY_DENIED'
  | 'TOOL_NOT_ALLOWED'
  | 'MANDATE_NOT_FOUND'
  | 'MANDATE_LIMIT_EXCEEDED'
  | 'MANDATE_NOT_OWNED'
  | 'RESOURCE_OUT_OF_SCOPE'
  | 'ASSET_CURRENCY_MISMATCH'
  /** The purchase named a currency the registry does not know (backlog 62). */
  | 'CURRENCY_UNKNOWN'
  | 'RISK_THRESHOLD_EXCEEDED'
  | 'VELOCITY_EXCEEDED'
  | 'DUPLICATE_REQUEST'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'ESCALATION_REQUIRED'
  | 'ENVIRONMENT_UNRESOLVED'
  /** A sandbox never moves more than its per-currency ceiling per decision. */
  | 'SANDBOX_CEILING_EXCEEDED'
  /** A sandbox cannot pay in this currency at all. */
  | 'SANDBOX_CEILING_UNKNOWN'
  | 'INTERNAL_ERROR';

export interface AuthorizeContext {
  sessionId?: string;
  userRef?: string;
  ip?: string;
  chain?: string;
  amountUsd?: number;
  /** The sum in `currency` (preferred over amountUsd). Budgets are per currency: the gate
   *  checks it against the agent's mandate in that currency. Passed through as `amount`. */
  amount?: number;
  /** ISO 4217 code (or an on-chain asset); absent = USD. Passed through as `currency`. */
  currency?: string;
  /** Who the money goes to, in the agent's own words (the gate labels it payee_source "agent";
   *  a rail's word only reaches the gate through a sidecar or the gateway). Caps per seller
   *  in the mandate are checked against it. */
  payee?: string;
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
  /** AP2 v0.2: ask the gate for mandate chains bound to a merchant-signed Checkout JWT (money actions). */
  ap2?: {
    checkout_jwt: string;
    nonce?: string;
    aud?: string;
    payee?: { id: string; name: string; website?: string };
    instrument?: { id: string; type: string; description?: string };
    expires_at?: string;
  };
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

export interface Ap2Evidence {
  spec: string;
  /** Compact SD-JWT delegation chains (open~…~~closed~…). */
  checkout_mandate: string;
  payment_mandate: string;
  /** base64url SHA-256 of the Checkout JWT. */
  transaction_id: string;
  open_checkout_hash: string;
  checkout_reference: string;
  payment_reference: string;
  nonce: string;
  aud: string;
  provider_kid: string;
  agent_jwk: Record<string, unknown>;
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
  /** AP2 v0.2 evidence — present only when context.ap2.checkout_jwt was supplied. */
  ap2?: Ap2Evidence;
}

export interface DenyDecision {
  decision: 'deny';
  allowed: false;
  decisionId: string;
  code: DecisionCode;
  reason: string;
  /** For MANDATE_NOT_FOUND / CURRENCY_UNKNOWN / SANDBOX_CEILING_*: the purchase currency the
   *  refusal is about — "no budget in EUR" means ask the owner for a EUR budget. */
  currency?: string;
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
  /** Decision API base URL. Default: https://control-api.regentprotocol.org */
  baseUrl?: string;
  /** Optional per-agent HMAC secret; if set, requests are signed (X-Agent-Signature). */
  agentSecret?: string;
  /** Per-request timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /** Max retries on network / 429 / 5xx. Default 2. */
  maxRetries?: number;
  /** The agent's own Ed25519 key (the file `enroll` / `onboard` wrote): every request is then
   *  signed with it (RFC 9421) and the receipts name the agent's key. */
  signingKey?: AgentKey;
  /** Path of that key file (~/.regent/agent-key.json); read once at construction. */
  signingKeyFile?: string;
  /** Cloud Gateway base URL. Default: https://gw.regentprotocol.org */
  gatewayUrl?: string;
}

/** One tool call through the Cloud Gateway (`/gw/{tool}/{path}`). */
export interface GatewayInput {
  /** HTTP method the tool expects. Default POST. */
  method?: string;
  /** JSON body (serialised as sent). */
  body?: unknown;
  /** Query string parameters. */
  query?: Record<string, string>;
  /** Why the agent does this, in its own words (X-Agent-Intent). */
  intent?: string;
  /** The retry handle: an escalated call is repeated with the same key after approval. */
  idempotencyKey?: string;
  /** Verified facts the policy keys on (X-Agent-Facts). */
  facts?: Record<string, unknown>;
  /** The human's OIDC token the agent acts for (X-Agent-User-Token). */
  userToken?: string;
}

/**
 * What the Cloud Gateway answered for one tool call. On allow, the provider's own response
 * (`status`, `data` when JSON, `text`); on a refusal, the gate's verdict (`decision`, `code`,
 * `reason`, `decisionId`) — a refusal is an answer, not an error.
 */
export interface GatewayResponse {
  ok: boolean;
  status: number;
  data?: unknown;
  text: string;
  decision?: 'allow' | 'deny' | 'escalate';
  decisionId?: string;
  code?: string;
  reason?: string;
  headers: Record<string, string>;
  /** `code === 'ESCALATION_REQUIRED'`: a person decides; repeat with the same idempotencyKey. */
  escalated: boolean;
}
