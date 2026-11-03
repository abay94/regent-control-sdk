import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegentControl } from '../src/client.js';
import { resourcePath } from '../src/x402.js';

function capture(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }));
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe('x402 (task 33)', () => {
  it('turns a URL into the gateway resource path', () => {
    expect(resourcePath('https://api.example.com/v1/quote?city=Astana&n=2')).toEqual(['api.example.com/v1/quote', { city: 'Astana', n: '2' }]);
    expect(resourcePath('api.example.com/v1/quote')).toEqual(['api.example.com/v1/quote', {}]);
    expect(resourcePath('https://api.example.com')).toEqual(['api.example.com', {}]);
    expect(() => resourcePath('http://api.example.com/x')).toThrow(/https/);
  });

  it('fetches through the gateway and names what Regent did', async () => {
    const calls = capture(200, { quote: 42 }, {
      'x-regent-decision-id': 'dec_1', 'x-regent-settlement': 'verified', 'x-regent-network': 'base-sepolia', 'x-regent-transaction': '0xab',
    });
    const control = new RegentControl({ apiKey: 'rgnt_agt_test', agentId: 'agent_' + 'ab'.repeat(24), gatewayUrl: 'https://gw.test' });
    const r = await control.x402.fetch('https://api.example.com/v1/quote?city=Astana', { intent: 'price a courier', idempotencyKey: 'q-1' });
    expect(r.ok && r.paid && !r.escalated && !r.free).toBe(true);
    expect(r.data).toEqual({ quote: 42 });
    expect(r.decisionId).toBe('dec_1');
    expect(r.transaction).toBe('0xab');
    expect(calls[0].url).toBe('https://gw.test/gw/x402/api.example.com/v1/quote?city=Astana');
    expect(calls[0].init.method).toBe('GET');
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['X-Agent-Intent']).toBe('price a courier');
    expect(JSON.parse(h['X-Agent-Facts'])).toEqual({ idempotency_key: 'q-1' });
  });

  it('tells a free answer, a refusal and an escalation apart', async () => {
    const control = new RegentControl({ apiKey: 'rgnt_agt_test', agentId: 'agent_' + 'ab'.repeat(24), gatewayUrl: 'https://gw.test' });
    capture(200, { public: true });
    let r = await control.x402.fetch('https://api.example.com/open');
    expect(r.free && !r.paid && r.decisionId === undefined).toBe(true);
    capture(403, { decision: 'escalate', decision_id: 'dec_e', code: 'ESCALATION_REQUIRED', reason: 'awaiting human approval' });
    r = await control.x402.fetch('https://api.example.com/v1/quote', { idempotencyKey: 'q-2' });
    expect(r.escalated && r.decision === 'escalate' && r.decisionId === 'dec_e').toBe(true);
    capture(403, { decision: 'deny', decision_id: 'dec_d', code: 'MANDATE_NOT_FOUND', reason: 'no active USDC mandate' });
    r = await control.x402.fetch('https://api.example.com/v1/quote');
    expect(!r.ok && r.code === 'MANDATE_NOT_FOUND' && !r.paid).toBe(true);
  });
});
