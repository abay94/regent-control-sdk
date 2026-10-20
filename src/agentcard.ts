/**
 * The Agentcard rail from the SDK (20.10.2026): `control.agentcard.shop(...)` and
 * `control.agentcard.buy(...)` are the two gateway tools `agentcard_shop` and `agentcard_buy`
 * with their answers read into plain objects.
 *
 * Agentcard stores the owner's card and shops at Amazon, Walmart, Target and others; Regent
 * sits between the ask and the confirm. `shop` never moves money. `buy` is decided by the
 * gate on the cart's ceiling and the store it reads from Agentcard, under the owner's USD
 * budget; the first purchase, or anything above the allowance, comes back `escalated` and is
 * repeated with the same `idempotencyKey` after the owner approves. The agent never sees the
 * card. Docs: https://docs.regentprotocol.org/gateway/agentcard
 */
import type { GatewayResponse } from './types.js';

export const AGENTCARD_SHOP = 'agentcard_shop';
export const AGENTCARD_BUY = 'agentcard_buy';
const PATH = 'buy';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const cents = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : undefined;
};

export interface AgentcardItem {
  name: string;
  qty: number;
  priceCents?: number;
  url?: string;
}

/** One priced cart. `ceilingCents` is what the gate decides on and the owner approves. */
export interface AgentcardCart {
  hash: string;
  storeId?: string;
  storeName?: string;
  currency: string;
  totalCents?: number;
  ceilingCents?: number;
  isEstimate: boolean;
  /** The amount Regent decides on: the ceiling when the total is an estimate. */
  decidedCents?: number;
  items: AgentcardItem[];
  raw: Rec;
}

/** Agentcard's answer to an ask: a conversation to continue, the carts it priced, its words. */
export interface AgentcardAsk {
  response: GatewayResponse;
  ok: boolean;
  conversationId?: string;
  status?: string;
  reply?: string;
  carts: AgentcardCart[];
  /** The first cart, or undefined while Agentcard still needs input. */
  cart?: AgentcardCart;
}

/** What came back from a confirm: escalated → refused → Agentcard's own status. */
export interface AgentcardOrder {
  response: GatewayResponse;
  escalated: boolean;
  refused: boolean;
  placed: boolean;
  status?: string;
  orderId?: string;
  approvalUrl?: string;
  declineCode?: string;
  reply?: string;
  decisionId?: string;
  code?: string;
  reason?: string;
}

export function cartFromWire(d: Rec): AgentcardCart {
  const store = rec(d.store);
  const total = cents(d.totalCents);
  const ceiling = cents(d.approvedCeilingCents) ?? total;
  const isEstimate = Boolean(d.totalIsEstimate);
  const items = (Array.isArray(d.items) ? d.items : []).map((i) => {
    const r = rec(i);
    return { name: String(r.name ?? ''), qty: Number(r.qty ?? 1), priceCents: cents(r.priceCents),
             url: (r.url ?? r.product_id) as string | undefined };
  });
  return {
    hash: String(d.hash ?? ''),
    storeId: store.id as string | undefined,
    storeName: (store.name ?? d.merchant_name) as string | undefined,
    currency: String(d.currency ?? 'usd').toUpperCase(),
    totalCents: total, ceilingCents: ceiling, isEstimate,
    decidedCents: isEstimate ? ceiling : total,
    items, raw: d,
  };
}

export function askFromResponse(r: GatewayResponse): AgentcardAsk {
  const d = rec(r.data);
  const cartsRaw = Array.isArray(d.carts) ? d.carts : d.cart && typeof d.cart === 'object' ? [d.cart] : [];
  const carts = cartsRaw.map((c) => cartFromWire(rec(c)));
  return { response: r, ok: r.ok, conversationId: d.conversation_id as string | undefined, status: d.status as string | undefined,
           reply: (d.reply ?? d.message) as string | undefined, carts, cart: carts[0] };
}

export function orderFromResponse(r: GatewayResponse): AgentcardOrder {
  const d = r.ok ? rec(r.data) : {};
  const status = d.status as string | undefined;
  return {
    response: r, escalated: r.escalated, refused: !r.ok && !r.escalated, placed: r.ok && status === 'order_placed',
    status, orderId: d.order_id as string | undefined, approvalUrl: d.approval_url as string | undefined,
    declineCode: d.decline_code as string | undefined, reply: d.reply as string | undefined,
    decisionId: r.decisionId, code: r.code, reason: r.reason,
  };
}

export interface GatewayCaller {
  gateway(tool: string, path: string, input: { body?: unknown; intent?: string; idempotencyKey?: string }): Promise<GatewayResponse>;
}

/** `control.agentcard` — the owner's card through Agentcard, two calls. */
export class Agentcard {
  readonly #c: GatewayCaller;
  constructor(c: GatewayCaller) { this.#c = c; }

  /** Ask Agentcard to find and price something, or continue a conversation. Never moves money. */
  async shop(ask: string, opts: { conversationId?: string; intent?: string } = {}): Promise<AgentcardAsk> {
    const body: Rec = { ask };
    if (opts.conversationId) body.conversation_id = opts.conversationId;
    return askFromResponse(await this.#c.gateway(AGENTCARD_SHOP, PATH, { body, intent: opts.intent }));
  }

  /** Confirm a cart. Decided by the gate first; on `escalated`, repeat with the SAME idempotencyKey after the owner approves. */
  async buy(conversationId: string, cartHash: string, opts: { idempotencyKey: string; intent?: string }): Promise<AgentcardOrder> {
    return orderFromResponse(await this.#c.gateway(AGENTCARD_BUY, PATH, {
      body: { conversation_id: conversationId, confirm: cartHash }, idempotencyKey: opts.idempotencyKey, intent: opts.intent,
    }));
  }
}
