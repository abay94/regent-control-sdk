import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readKeyFile } from './agentkey.js';
import type { AgentKey } from './agentkey.js';
import { HttpClient } from './http.js';
import type {
  AuthorizeInput,
  CompleteInput,
  CompleteResult,
  Decision,
  DecisionCode,
  GatewayInput,
  GatewayResponse,
  RegentControlConfig,
} from './types.js';

// The Decision API lives on the control host; api.regentprotocol.org is the platform (console, enrolment)
// and answers 404 for /v1/control/decisions. Same default as the Python SDK since 0.3.1.
const DEFAULT_BASE_URL = 'https://control-api.regentprotocol.org';
const DEFAULT_GATEWAY_URL = 'https://gw.regentprotocol.org';

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
  readonly #gateway: HttpClient;
  readonly #agentId: string;

  constructor(config: RegentControlConfig) {
    this.#agentId = config.agentId;
    const signingKey: AgentKey | undefined =
      config.signingKey ?? (config.signingKeyFile ? readKeyFile(expandHome(config.signingKeyFile)) : undefined);
    const base = {
      apiKey: config.apiKey,
      agentSecret: config.agentSecret,
      signingKey,
      timeoutMs: config.timeoutMs ?? 10_000,
      maxRetries: config.maxRetries ?? 2,
    };
    this.#http = new HttpClient({ ...base, baseUrl: config.baseUrl ?? DEFAULT_BASE_URL });
    this.#gateway = new HttpClient({ ...base, baseUrl: config.gatewayUrl ?? DEFAULT_GATEWAY_URL });
  }

  /**
   * A client from the file `enroll` / `onboard` wrote (~/.regent/credentials.json): the
   * control key bound to this agent, its id, the control URL and its own signing key.
   * Overrides win.
   */
  static fromCredentials(path?: string, overrides: Partial<RegentControlConfig> = {}): RegentControl {
    const p = expandHome(path ?? join(process.env.REGENT_HOME || join(homedir(), '.regent'), 'credentials.json'));
    const data = JSON.parse(readFileSync(p, 'utf8')) as {
      api_key?: string; agent_id?: string; base_url?: string; platform_url?: string; gateway_url?: string; signing_key_file?: string;
    };
    for (const f of ['api_key', 'agent_id', 'base_url'] as const) {
      if (!data[f]) throw new Error(`${p}: missing ${f}`);
    }
    return new RegentControl({
      apiKey: data.api_key!,
      agentId: data.agent_id!,
      baseUrl: data.base_url!,
      ...(data.gateway_url ? { gatewayUrl: data.gateway_url } : {}),
      ...(data.signing_key_file ? { signingKeyFile: data.signing_key_file } : {}),
      ...overrides,
    });
  }

  /**
   * Call a tool through the Cloud Gateway (`/gw/{tool}/{path}`): Agentcard, Stripe through
   * the vault, any catalog tool. The gate decides first; on allow the provider's response
   * comes back, on a refusal the verdict does (`code`, `reason`). Signed with the agent's
   * own key when the client has one — the gateway verifies it and the gate records this
   * agent's key in the receipt. An escalated call is repeated with the same idempotencyKey
   * after the person approves.
   */
  async gateway(tool: string, path = '', input: GatewayInput = {}): Promise<GatewayResponse> {
    const method = (input.method ?? 'POST').toUpperCase();
    const body = input.body === undefined ? '' : JSON.stringify(input.body);
    const headers: Record<string, string> = {};
    if (input.intent) headers['X-Agent-Intent'] = input.intent;
    if (input.userToken) headers['X-Agent-User-Token'] = input.userToken;
    const facts: Record<string, unknown> = { ...(input.facts ?? {}) };
    if (input.idempotencyKey) facts.idempotency_key = input.idempotencyKey;
    if (Object.keys(facts).length) headers['X-Agent-Facts'] = JSON.stringify(facts);
    const qs = input.query ? '?' + new URLSearchParams(input.query).toString() : '';
    const res = await this.#gateway.raw(method, `/gw/${encodeURIComponent(tool)}/${path.replace(/^\//, '')}${qs}`, body, headers);
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    const ok = res.status < 400;
    const verdict = (!ok && data && typeof data === 'object' ? (data as Record<string, unknown>) : {}) as Record<string, unknown>;
    const out: GatewayResponse = {
      ok,
      status: res.status,
      data,
      text,
      decision: ok ? 'allow' : (verdict.decision as GatewayResponse['decision']),
      decisionId: verdict.decision_id as string | undefined,
      code: verdict.code as string | undefined,
      reason: verdict.reason as string | undefined,
      headers: headersOf(res),
      escalated: verdict.code === 'ESCALATION_REQUIRED',
    };
    return out;
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
        amount: ctx.amount,
        currency: ctx.currency,
        payee: ctx.payee,
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

function headersOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
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
  currency?: string;
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
  'amount',
  'currency',
  'payee',
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
    ...(w.currency ? { currency: String(w.currency).toUpperCase() } : {}),
  };
}
