import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegentControl } from '../src/client.js';
import { ControlError, ControlDenied } from '../src/errors.js';
import type { Decision } from '../src/types.js';

function mockFetchOnce(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    }),
  );
}

const control = () =>
  new RegentControl({ apiKey: 'rgnt_ctrl_test', agentId: 'agent_hermes_001', maxRetries: 0 });

afterEach(() => vi.restoreAllMocks());

describe('authorize', () => {
  it('returns an allow decision with a token', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(200, {
        decision: 'allow',
        decision_id: 'dec_abc',
        token: 'eyJ...',
        expires_at: '2026-06-13T14:32:09Z',
        risk_score: 0.12,
        obligations: [],
      }),
    );
    const d = await control().authorize({ tool: 'salesforce', action: 'contact.read' });
    expect(d.decision).toBe('allow');
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.token).toBe('eyJ...');
  });

  it('returns a deny decision (200, not thrown)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(200, {
        decision: 'deny',
        decision_id: 'dec_xyz',
        code: 'MANDATE_LIMIT_EXCEEDED',
        reason: 'daily limit reached',
      }),
    );
    const d = await control().authorize({
      tool: 'stripe',
      action: 'charge.create',
      context: { amountUsd: 550, mandateId: 'mnd_1' },
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe('MANDATE_LIMIT_EXCEEDED');
  });

  it('sends camelCase context as snake_case on the wire', async () => {
    const spy = mockFetchOnce(200, { decision: 'allow', decision_id: 'd', token: 't', expires_at: 'x', obligations: [] });
    vi.stubGlobal('fetch', spy);
    await control().authorize({
      tool: 'stripe',
      action: 'charge.create',
      context: { amountUsd: 25, mandateId: 'mnd_1', idempotencyKey: 'idem_1' },
    });
    const [, init] = spy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.agent_id).toBe('agent_hermes_001');
    expect(body.context.amount_usd).toBe(25);
    expect(body.context.mandate_id).toBe('mnd_1');
    expect((init as RequestInit).headers).toMatchObject({ 'Idempotency-Key': 'idem_1' });
  });

  it('throws ControlError on 401 (auth failure, not a decision)', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(401, { error: 'unauthorized' }));
    await expect(control().authorize({ tool: 't', action: 'a' })).rejects.toBeInstanceOf(ControlError);
  });

  it('signs the body with HMAC when an agentSecret is set', async () => {
    const spy = mockFetchOnce(200, { decision: 'allow', decision_id: 'd', token: 't', expires_at: 'x', obligations: [] });
    vi.stubGlobal('fetch', spy);
    const c = new RegentControl({
      apiKey: 'rgnt_ctrl_test',
      agentId: 'a',
      agentSecret: 'shhh',
      maxRetries: 0,
    });
    await c.authorize({ tool: 't', action: 'a' });
    const [, init] = spy.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['X-Agent-Signature']).toMatch(/^hmac-sha256=[0-9a-f]{64}$/);
    expect(headers['X-Agent-Signature-Timestamp']).toBeDefined();
  });
});

describe('complete', () => {
  it('reports the outcome and maps the response', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(200, { decision_id: 'dec_abc', recorded: true, mandate_reconciled: false }),
    );
    const r = await control().complete('dec_abc', { status: 'success', downstreamRef: 'ch_1' });
    expect(r.recorded).toBe(true);
    expect(r.decisionId).toBe('dec_abc');
  });
});

describe('ControlDenied helper', () => {
  it('carries the code and decisionId', () => {
    const d: Decision = {
      decision: 'deny',
      allowed: false,
      decisionId: 'dec_1',
      code: 'POLICY_DENIED',
      reason: 'nope',
    };
    if (!d.allowed) {
      const e = new ControlDenied(d.code, d.reason, d.decisionId);
      expect(e.code).toBe('POLICY_DENIED');
      expect(e.decisionId).toBe('dec_1');
    }
  });
});
