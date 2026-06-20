// Cross-process e2e: real @regent/control-sdk -> running api-control (:8006)
// -> mock upstreams. Proves the wire contract end to end, including that the
// issued scoped token verifies against the live JWKS.

import crypto from 'node:crypto';
import { RegentControl, ControlDenied, ControlError, deriveAgentSecret } from '../dist/index.js';

const BASE = 'http://127.0.0.1:8006';
let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  console.error(`  ✗ ${m}`);
  failures++;
};

const hermes = new RegentControl({ apiKey: 'rgnt_ctrl_test', agentId: 'agent_hermes_001', baseUrl: BASE });
const revoked = new RegentControl({ apiKey: 'rgnt_ctrl_test', agentId: 'agent_revoked_001', baseUrl: BASE });

function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function verifyTokenAgainstJwks(token) {
  const jwks = await (await fetch(`${BASE}/v1/control/.well-known/jwks.json`)).json();
  const jwk = jwks.keys[0];
  const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const [h, p, s] = token.split('.');
  const verified = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${h}.${p}`),
    pub,
    b64urlToBuf(s),
  );
  const claims = JSON.parse(b64urlToBuf(p).toString());
  return { verified, claims };
}

console.log('Regent Control — cross-process e2e\n');

// 1. allow + token verifies against JWKS
console.log('1) allow an in-policy read');
{
  const d = await hermes.authorize({ tool: 'salesforce', action: 'contact.read' });
  if (d.allowed) ok(`allow, decision ${d.decisionId}`);
  else bad(`expected allow, got ${d.decision}/${d.code}`);
  if (d.allowed) {
    const { verified, claims } = await verifyTokenAgainstJwks(d.token);
    verified ? ok('scoped token signature verifies against JWKS') : bad('token did NOT verify');
    claims.scope === 'salesforce:contact.read'
      ? ok(`token scope = ${claims.scope}`)
      : bad(`unexpected scope ${claims.scope}`);
    // close the loop
    const c = await hermes.complete(d.decisionId, { status: 'success', downstreamRef: 'sf_123' });
    c.recorded ? ok('complete() recorded') : bad('complete not recorded');
  }
}

// 2. allow a $25 charge (under the $50 mandate limit)
console.log('\n2) allow a $25 charge under the mandate');
{
  const d = await hermes.authorize({
    tool: 'stripe',
    action: 'charge.create',
    context: { amountUsd: 25, mandateId: 'mnd_1' },
  });
  d.allowed ? ok('allowed under limit') : bad(`expected allow, got ${d.decision}/${d.code}`);
}

// 3. deny a $550 charge (over the mandate limit)
console.log('\n3) deny a $550 charge over the mandate');
{
  const d = await hermes.authorize({
    tool: 'stripe',
    action: 'charge.create',
    context: { amountUsd: 550, mandateId: 'mnd_1' },
  });
  if (!d.allowed && d.code === 'MANDATE_LIMIT_EXCEEDED') ok(`deny ${d.code}`);
  else bad(`expected MANDATE_LIMIT_EXCEEDED, got ${d.decision}/${d.code ?? '-'}`);
}

// 4. deny a revoked agent (kill switch)
console.log('\n4) deny a revoked agent');
{
  const d = await revoked.authorize({ tool: 'salesforce', action: 'contact.read' });
  if (!d.allowed && d.code === 'AGENT_NOT_ACTIVE') ok(`deny ${d.code}`);
  else bad(`expected AGENT_NOT_ACTIVE, got ${d.decision}/${d.code ?? '-'}`);
}

// 5. ControlDenied helper usage
console.log('\n5) ControlDenied helper');
{
  const d = await revoked.authorize({ tool: 't', action: 'a' });
  if (!d.allowed) {
    try {
      throw new ControlDenied(d.code, d.reason, d.decisionId);
    } catch (e) {
      e instanceof ControlDenied && e.code === 'AGENT_NOT_ACTIVE'
        ? ok('throwable ControlDenied carries the code')
        : bad('ControlDenied mismatch');
    }
  }
}

// 6. auth: an invalid API key is rejected (401 -> ControlError)
console.log('\n6) reject an invalid API key');
{
  const badKey = new RegentControl({ apiKey: 'rgnt_ctrl_WRONG', agentId: 'agent_hermes_001', baseUrl: BASE });
  try {
    await badKey.authorize({ tool: 'salesforce', action: 'contact.read' });
    bad('expected ControlError for bad key');
  } catch (e) {
    e instanceof ControlError && e.statusCode === 401
      ? ok('invalid key rejected with 401')
      : bad(`unexpected error: ${e}`);
  }
}

// 7. signed request (HMAC) verifies server-side
console.log('\n7) signed request (HMAC) accepted');
{
  const secret = await deriveAgentSecret('rgnt_ctrl_test', 'agent_hermes_001');
  const signed = new RegentControl({
    apiKey: 'rgnt_ctrl_test',
    agentId: 'agent_hermes_001',
    baseUrl: BASE,
    agentSecret: secret,
  });
  const d = await signed.authorize({ tool: 'salesforce', action: 'contact.read' });
  d.allowed ? ok('signed request authorized') : bad(`signed request got ${d.decision}/${d.code}`);
}

console.log(`\n${failures === 0 ? '✅ ALL E2E CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
