import { describe, expect, it } from 'vitest';
import { RegentControl } from '../src/index.js';

const ASK_ANSWER = {
  conversation_id: 'conv_aaa4', status: 'needs_input', reply: 'Searching Amazon for AA batteries…',
  carts: [{ merchant: 'retail', merchant_name: 'Amazon', store: { id: 'amazon', name: 'Amazon' }, currency: 'usd',
            items: [{ name: 'Amazon Basics 20-Pack AA', qty: 1, priceCents: 999, url: 'https://www.amazon.com/dp/B00N' }],
            totalCents: 999, totalIsEstimate: true, approvedCeilingCents: 2099, hash: '6e9cfc4e7a8a2e86' }],
};

function capture(responder: (url: string, init: RequestInit, n: number) => { status: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const { status, body } = responder(u, init ?? {}, calls.length);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

const client = () => new RegentControl({ apiKey: 'rgnt_agt_x', agentId: 'agent_x', gatewayUrl: 'https://gw.test', maxRetries: 0 });

describe('control.agentcard', () => {
  it('shop sends the ask and reads the cart with the ceiling', async () => {
    const calls = capture(() => ({ status: 200, body: ASK_ANSWER }));
    const a = await client().agentcard.shop('one pack of AA batteries from Amazon, cheapest', { intent: 'batteries' });
    expect(a.ok && a.conversationId === 'conv_aaa4').toBe(true);
    expect(a.cart?.hash).toBe('6e9cfc4e7a8a2e86');
    expect(a.cart?.storeId).toBe('amazon');
    expect(a.cart?.currency).toBe('USD');
    expect(a.cart?.ceilingCents).toBe(2099);
    expect(a.cart?.decidedCents).toBe(2099);
    expect(a.cart?.items[0].priceCents).toBe(999);
    expect(calls[0].url).toBe('https://gw.test/gw/agentcard_shop/buy');
    expect(calls[0].init.body).toBe(JSON.stringify({ ask: 'one pack of AA batteries from Amazon, cheapest' }));
    expect((calls[0].init.headers as Record<string, string>)['X-Agent-Intent']).toBe('batteries');
  });

  it('buy escalates, then places the order with the same key', async () => {
    const keys: string[] = [];
    capture((_u, init, n) => {
      keys.push(JSON.parse((init.headers as Record<string, string>)['X-Agent-Facts']).idempotency_key);
      return n === 1
        ? { status: 403, body: { decision: 'escalate', decision_id: 'dec_7', code: 'ESCALATION_REQUIRED', reason: 'ask the owner' } }
        : { status: 200, body: { status: 'order_placed', order_id: 'ord_1', approval_url: 'https://agentcard.sh/a/1' } };
    });
    const c = client();
    let o = await c.agentcard.buy('conv_aaa4', '6e9cfc4e7a8a2e86', { idempotencyKey: 'batt-1', intent: 'batteries' });
    expect(o.escalated && !o.refused && !o.placed).toBe(true);
    expect(o.decisionId).toBe('dec_7');
    expect(o.code).toBe('ESCALATION_REQUIRED');
    o = await c.agentcard.buy('conv_aaa4', '6e9cfc4e7a8a2e86', { idempotencyKey: 'batt-1' });
    expect(o.placed).toBe(true);
    expect(o.orderId).toBe('ord_1');
    expect(o.approvalUrl).toBe('https://agentcard.sh/a/1');
    expect(keys).toEqual(['batt-1', 'batt-1']);
  });

  it('a gate refusal and an Agentcard decline are answers, not orders', async () => {
    capture(() => ({ status: 403, body: { decision: 'deny', decision_id: 'dec_8', code: 'MANDATE_NOT_FOUND', reason: 'no USD budget' } }));
    const o = await client().agentcard.buy('conv_aaa4', '6e9c', { idempotencyKey: 'batt-2' });
    expect(o.refused && o.code === 'MANDATE_NOT_FOUND' && !o.placed).toBe(true);
    capture(() => ({ status: 200, body: { status: 'needs_input', decline_code: 'sandbox_mode' } }));
    const d = await client().agentcard.buy('conv_aaa4', '6e9c', { idempotencyKey: 'batt-3' });
    expect(d.response.ok && !d.placed && d.declineCode === 'sandbox_mode').toBe(true);
  });
});
