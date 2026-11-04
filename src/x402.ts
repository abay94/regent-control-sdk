/**
 * x402 from the SDK (task 33, 03.11.2026): `control.x402.fetch(url)` fetches a web resource
 * that charges per request (HTTP 402) through the Cloud Gateway, which pays for it from the
 * organization's wallet under the agent's USDC budget.
 *
 * The agent names the resource by its plain URL; the gateway reaches it over https, reads
 * the 402's own price and recipient (never the agent's word), asks the gate, has the
 * connected wallet sign exactly that, retries with the payment and reads the transfer from
 * the chain before the decision closes. A free answer is passed through with no decision.
 * A resource above the agent's allowance comes back `escalated` and is repeated with the
 * same `idempotencyKey` after the owner approves. Docs: https://docs.regentprotocol.org/gateway/x402
 */
import type { GatewayInput, GatewayResponse } from './types.js';

export const X402_TOOL = 'x402';

/** The resource's answer plus what Regent did for it. */
export interface X402Result {
  ok: boolean;
  status: number;
  data?: unknown;
  text: string;
  decisionId?: string;
  /** `verified` (the transfer was read from the chain and the decision closed), `pending` (held open until the chain confirms), `unverified`, `none`; undefined when free or refused. */
  settlement?: string;
  transaction?: string;
  network?: string;
  decision?: 'allow' | 'deny' | 'escalate';
  code?: string;
  reason?: string;
  headers: Record<string, string>;
  /** True only when the transfer was read from the chain and the decision closed on it. */
  paid: boolean;
  /** A person decides; repeat with the same idempotencyKey. */
  escalated: boolean;
  /** The resource answered without asking for payment: no decision, nothing moved. */
  free: boolean;
}

export interface X402FetchInput extends Omit<GatewayInput, 'userToken'> {}

/**
 * `https://api.example.com/v1/quote?city=Astana` → `['api.example.com/v1/quote', { city: 'Astana' }]`.
 * The gateway's tool path names the resource as `<host>/<path>`; https is implied.
 */
export function resourcePath(url: string): [string, Record<string, string>] {
  let raw = url.trim();
  if (raw.startsWith('http://')) throw new Error('a paid resource is reached over https only');
  if (!raw.startsWith('https://')) raw = 'https://' + raw;
  const u = new URL(raw);
  if (!u.hostname) throw new Error('name the resource as https://<host>/<path>');
  const path = u.pathname.replace(/^\/+/, '');
  const query: Record<string, string> = {};
  u.searchParams.forEach((v, k) => {
    query[k] = v;
  });
  return [path ? `${u.hostname}/${path}` : u.hostname, query];
}

export function x402Result(r: GatewayResponse): X402Result {
  const h = r.headers;
  const decisionId = h['x-regent-decision-id'] ?? r.decisionId;
  const settlement = h['x-regent-settlement'];
  return {
    ok: r.ok,
    status: r.status,
    data: r.data,
    text: r.text,
    decisionId,
    settlement,
    transaction: h['x-regent-transaction'],
    network: h['x-regent-network'],
    decision: r.decision,
    code: r.code,
    reason: r.reason,
    headers: h,
    paid: r.ok && settlement === 'verified',
    escalated: r.escalated,
    free: r.ok && decisionId === undefined,
  };
}

type GatewayCaller = { gateway(tool: string, path?: string, input?: GatewayInput): Promise<GatewayResponse> };

export class X402 {
  readonly #rc: GatewayCaller;

  constructor(rc: GatewayCaller) {
    this.#rc = rc;
  }

  /** Fetch `url`, paying for it if it asks. `input.query` adds to the URL's own parameters. */
  async fetch(url: string, input: X402FetchInput = {}): Promise<X402Result> {
    const [path, query] = resourcePath(url);
    const merged = { ...query, ...(input.query ?? {}) };
    const r = await this.#rc.gateway(X402_TOOL, path, {
      ...input,
      method: input.method ?? 'GET',
      query: Object.keys(merged).length ? merged : undefined,
    });
    return x402Result(r);
  }
}
