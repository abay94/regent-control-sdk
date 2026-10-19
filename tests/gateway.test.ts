import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RegentControl } from '../src/client.js';
import { generateAgentKey, writeCredentials } from '../src/agentkey.js';
import { authorityOf, contentDigest, signRequest, signatureBase } from '../src/httpsig.js';

const ASK = { ask: 'one pack of AA batteries from Amazon, cheapest' };

function capture(status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  });
  vi.stubGlobal('fetch', f);
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe('RFC 9421 signing', () => {
  it('matches the Python profile byte for byte and verifies with node:crypto', () => {
    const key = generateAgentKey();
    const body = JSON.stringify(ASK);
    const h = signRequest(key, 'POST', 'https://gw.regentprotocol.org/gw/agentcard_shop/buy', body, 1760000000);
    expect(h['Content-Digest']).toBe(contentDigest(body));
    expect(h['Signature-Input']).toBe(
      `regent=("@method" "@authority" "@path" "content-digest");created=1760000000;keyid="${key.kid}";alg="ed25519";tag="regent-agent"`,
    );
    expect(h['Signature']).toMatch(/^regent=:[A-Za-z0-9+/]+=*:$/);
    const params = h['Signature-Input'].slice('regent='.length);
    const base = signatureBase('POST', 'https://gw.regentprotocol.org/gw/agentcard_shop/buy', h, ['@method', '@authority', '@path', 'content-digest'], params);
    expect(base).toBe(
      `"@method": POST\n"@authority": gw.regentprotocol.org\n"@path": /gw/agentcard_shop/buy\n"content-digest": ${h['Content-Digest']}\n"@signature-params": ${params}`,
    );
    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.public_key }, format: 'jwk' });
    const sig = Buffer.from(h['Signature'].slice('regent=:'.length, -1), 'base64');
    expect(verify(null, Buffer.from(base), pub, sig)).toBe(true);
    // no body → no digest and three covered components
    const g = signRequest(key, 'GET', 'http://localhost:8080/gw/stripe/v1/balance?limit=3', '', 1760000000);
    expect(g['Content-Digest']).toBeUndefined();
    expect(g['Signature-Input']).toContain('("@method" "@authority" "@path");');
    expect(authorityOf('http://localhost:8080/x')).toBe('localhost:8080');
    expect(authorityOf('https://GW.regentprotocol.org:443/x')).toBe('gw.regentprotocol.org');
  });
});

describe('gateway()', () => {
  it('signs with the agent key, carries intent and idempotency, returns the provider answer', async () => {
    const key = generateAgentKey();
    const calls = capture(200, { conversation_id: 'conv_1', carts: [{ hash: '9f2c', totalCents: 999 }] });
    const c = new RegentControl({ apiKey: 'rgnt_agt_hark', agentId: 'agent_x', signingKey: key, gatewayUrl: 'https://gw.test', maxRetries: 0 });
    const r = await c.gateway('agentcard_shop', 'buy', { body: ASK, intent: 'batteries for the office', idempotencyKey: 'batt-1' });
    expect(r.ok && r.status === 200 && r.decision === 'allow' && !r.escalated).toBe(true);
    expect((r.data as { conversation_id: string }).conversation_id).toBe('conv_1');
    const { url, init } = calls[0];
    const h = init.headers as Record<string, string>;
    expect(url).toBe('https://gw.test/gw/agentcard_shop/buy');
    expect(init.method).toBe('POST');
    expect(h.Authorization).toBe('Bearer rgnt_agt_hark');
    expect(h['X-Agent-Intent']).toBe('batteries for the office');
    expect(JSON.parse(h['X-Agent-Facts'])).toEqual({ idempotency_key: 'batt-1' });
    expect(init.body).toBe(JSON.stringify(ASK));
    expect(h['Signature-Input']).toContain(`keyid="${key.kid}"`);
    expect(h['Content-Digest']).toBe(contentDigest(JSON.stringify(ASK)));
    expect(h['X-Agent-Signature']).toBeUndefined();
    expect(h['X-Agent-Id']).toBeUndefined();
  });

  it('returns a refusal as a value with the gate\'s own code', async () => {
    capture(403, { decision: 'escalate', decision_id: 'dec_7', code: 'ESCALATION_REQUIRED', reason: 'ask the owner' });
    const c = new RegentControl({ apiKey: 'k', agentId: 'a', gatewayUrl: 'https://gw.test', maxRetries: 0 });
    const r = await c.gateway('agentcard_buy', 'buy', { body: { conversation_id: 'conv_1', confirm: '9f2c' }, idempotencyKey: 'batt-1' });
    expect(r.ok).toBe(false);
    expect(r.escalated).toBe(true);
    expect(r.decision).toBe('escalate');
    expect(r.decisionId).toBe('dec_7');
    expect(r.reason).toBe('ask the owner');
    capture(403, { decision: 'deny', code: 'SIGNATURE_REQUIRED', reason: 'sign it' });
    const d = await c.gateway('stripe', 'v1/balance', { method: 'GET' });
    expect(d.code).toBe('SIGNATURE_REQUIRED');
    expect(d.decision).toBe('deny');
  });

  it('GET with a query sends no body, no digest, no content-type; non-JSON stays text', async () => {
    const calls = capture(200, 'plain text, not json', { 'content-type': 'text/plain' });
    const c = new RegentControl({ apiKey: 'k', agentId: 'a', signingKey: generateAgentKey(), gatewayUrl: 'https://gw.test', maxRetries: 0 });
    const r = await c.gateway('stripe', 'v1/charges', { method: 'GET', query: { limit: '3' } });
    const { url, init } = calls[0];
    const h = init.headers as Record<string, string>;
    expect(url).toBe('https://gw.test/gw/stripe/v1/charges?limit=3');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(h['Content-Digest']).toBeUndefined();
    expect(h['Content-Type']).toBeUndefined();
    expect(h['Signature-Input']).toContain('("@method" "@authority" "@path");');
    expect(r.ok).toBe(true);
    expect(r.data).toBeUndefined();
    expect(r.text).toBe('plain text, not json');
  });

  it('fromCredentials picks up the bound key, the signing key file and the gateway url', async () => {
    const home = mkdtempSync(join(tmpdir(), 'regent-'));
    const key = generateAgentKey();
    writeFileSync(join(home, 'agent-key.json'), JSON.stringify(key));
    writeCredentials(join(home, 'credentials.json'), {
      api_key: 'rgnt_agt_x', agent_id: 'agent_x', base_url: 'https://gate.test', platform_url: 'https://api.test',
      signing_key_file: join(home, 'agent-key.json'),
    });
    writeFileSync(join(home, 'credentials.json'), JSON.stringify({
      api_key: 'rgnt_agt_x', agent_id: 'agent_x', base_url: 'https://gate.test', platform_url: 'https://api.test',
      gateway_url: 'https://gw.example', signing_key_file: join(home, 'agent-key.json'),
    }));
    const calls = capture(200, {});
    const c = RegentControl.fromCredentials(join(home, 'credentials.json'), { maxRetries: 0 });
    await c.gateway('agentcard_shop', 'buy', { body: ASK });
    expect(calls[0].url).toBe('https://gw.example/gw/agentcard_shop/buy');
    expect((calls[0].init.headers as Record<string, string>)['Signature-Input']).toContain(`keyid="${key.kid}"`);
    // and authorize() now signs with the same key instead of the HMAC
    capture(200, { decision: 'allow', decision_id: 'dec_1', token: 't', expires_at: '2099-01-01T00:00:00Z' });
    const d = await c.authorize({ tool: 'stripe', action: 'charge.create' });
    expect(d.allowed).toBe(true);
  });
});
