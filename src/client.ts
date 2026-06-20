import { HttpClient } from './http.js';
import type {
  AuthorizeInput,
  CompleteInput,
  CompleteResult,
  Decision,
  DecisionCode,
  RegentControlConfig,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.regentprotocol.org';

/**
 * Regent Control client — the gate in front of an AI agent's actions.
 *
 * ```ts
 * const control = new RegentControl({ apiKey, agentId });
 * const d = await control.authorize({ tool: 'stripe', action: 'charge.create',
 *   context: { amountUsd: 50, mandateId: 'mnd_1' } });
 * if (!d.allowed) throw new ControlDenied(d.code, d.reason, d.decisionId);
 * // ... perform the action, attaching d.token ...
 * await control.complete(d.decisionId, { status: 'success', downstreamRef: chargeId });
 * ```
 */
export class RegentControl {
  readonly #http: HttpClient;
  readonly #agentId: string;

  constructor(config: RegentControlConfig) {
    this.#agentId = config.agentId;
    this.#http = new HttpClient({
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      apiKey: config.apiKey,
      agentSecret: config.agentSecret,
      timeoutMs: config.timeoutMs ?? 10_000,
      maxRetries: config.maxRetries ?? 2,
    });
  }

  /** Authorize a proposed agent action. Returns allow / deny / escalate. */
  async authorize(input: AuthorizeInput): Promise<Decision> {
    const ctx = input.context ?? {};
    const body = {
      agent_id: this.#agentId,
      tool: input.tool,
      action: input.action,
      resource: input.resource,
      args: input.args ?? {},
      context: {
        session_id: ctx.sessionId,
        user_ref: ctx.userRef,
        ip: ctx.ip,
        chain: ctx.chain,
        amount_usd: ctx.amountUsd,
        mandate_id: ctx.mandateId,
        idempotency_key: ctx.idempotencyKey,
        user_token: ctx.userToken,
        intent: ctx.intent,
        reasoning_summary: ctx.reasoningSummary,
        task: ctx.task,
        op: ctx.op,
        resource_type: ctx.resourceType,
        account_status: ctx.accountStatus,
        refund_to_original: ctx.refundToOriginal,
        ...stripKnown(ctx),
      },
    };
    const headers = ctx.idempotencyKey ? { 'Idempotency-Key': ctx.idempotencyKey } : undefined;
    const raw = await this.#http.post<WireDecision>('/v1/control/decisions', body, headers);
    return toDecision(raw);
  }

  /** Report the outcome of an authorized action (closes audit, reconciles counters). */
  async complete(decisionId: string, input: CompleteInput): Promise<CompleteResult> {
    const raw = await this.#http.post<WireComplete>(
      `/v1/control/decisions/${encodeURIComponent(decisionId)}/complete`,
      { status: input.status, downstream_ref: input.downstreamRef, error: input.error ?? null },
    );
    return {
      decisionId: raw.decision_id,
      recorded: raw.recorded,
      mandateReconciled: raw.mandate_reconciled ?? false,
    };
  }
}

// ── wire shapes + translation ─────────────────────────────────────────────────

interface WireDecision {
  decision: 'allow' | 'deny' | 'escalate';
  decision_id: string;
  token?: string;
  expires_at?: string;
  risk_score?: number;
  obligations?: Array<{ type: string; fields?: string[] }>;
  code?: string;
  reason?: string;
  escalation?: { type: 'ciba' | 'manual' | 'webhook'; approver?: string; ref: string; expires_at?: string };
}

interface WireComplete {
  decision_id: string;
  recorded: boolean;
  mandate_reconciled?: boolean;
}

const KNOWN_CTX = new Set([
  'sessionId',
  'userRef',
  'ip',
  'chain',
  'amountUsd',
  'mandateId',
  'idempotencyKey',
  'userToken',
  'intent',
  'reasoningSummary',
  'task',
  'op',
  'resourceType',
  'accountStatus',
  'refundToOriginal',
]);

/** Pass through any extra (unknown) context keys verbatim. */
function stripKnown(ctx: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (!KNOWN_CTX.has(k)) extra[k] = v;
  }
  return extra;
}

function toDecision(w: WireDecision): Decision {
  if (w.decision === 'allow') {
    return {
      decision: 'allow',
      allowed: true,
      decisionId: w.decision_id,
      token: w.token!,
      expiresAt: w.expires_at!,
      riskScore: w.risk_score,
      obligations: w.obligations ?? [],
    };
  }
  if (w.decision === 'escalate') {
    return {
      decision: 'escalate',
      allowed: false,
      decisionId: w.decision_id,
      code: w.code as DecisionCode,
      reason: w.reason ?? '',
      escalation: {
        type: w.escalation!.type,
        approver: w.escalation!.approver,
        ref: w.escalation!.ref,
        expiresAt: w.escalation!.expires_at,
      },
    };
  }
  return {
    decision: 'deny',
    allowed: false,
    decisionId: w.decision_id,
    code: w.code as DecisionCode,
    reason: w.reason ?? '',
  };
}
