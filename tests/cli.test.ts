import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { generateAgentKey, kidFor, proofOfPossession, PROOF_V1 } from '../src/agentkey.js';
import { onboard, enroll } from '../src/cli.js';

function res(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('agent key', () => {
  it('produces a kid that matches the Python thumbprint rule and a verifiable proof', () => {
    const key = generateAgentKey();
    expect(key.kid).toBe(kidFor(key.public_key));
    expect(Buffer.from(key.public_key, 'base64url')).toHaveLength(32);
    const proof = proofOfPossession(key, 'org-1', 'agent_x');
    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.public_key }, format: 'jwk' });
    const ok = verify(null, Buffer.from(`${PROOF_V1}\norg-1\nagent_x\n${key.kid}`), pub, Buffer.from(proof, 'base64url'));
    expect(ok).toBe(true);
  });
});

describe('onboard', () => {
  it('prints the link, waits, claims with its own key and writes the credentials', async () => {
    const home = mkdtempSync(join(tmpdir(), 'regent-'));
    process.env.REGENT_HOME = home;
    let polls = 0;
    let claimed: any = null;
    const f = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/v1/onboard') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body)).agent_name).toBe('Grocery helper');
        return res(201, { onboard_url: 'https://web.test/onboard?token=T', poll_code: 'rgnt_onb_abc', poll_interval: 0 });
      }
      if (u.endsWith('/v1/onboard/claim/rgnt_onb_abc') && (!init || !init.method)) {
        polls += 1;
        return polls < 3 ? res(200, { status: 'pending' }) : res(200, { status: 'approved', organization_id: 'org-1', agent_id: 'agent_x' });
      }
      if (u.endsWith('/v1/onboard/claim/rgnt_onb_abc') && init?.method === 'POST') {
        claimed = JSON.parse(String(init.body));
        return res(200, { status: 'claimed', organization_id: 'org-1', agent_id: 'agent_x', environment: 'sandbox', kid: 'k',
          control_key: 'rgnt_agt_secret', control_url: 'https://gate.test', platform_url: 'https://api.test' });
      }
      return res(404, {});
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    const code = await onboard(['--name', 'Grocery helper', '--vendor', 'Muse', '--platform-url', 'https://api.test'], { fetch: f, sleep: async () => {}, log: (s) => lines.push(s) });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('https://web.test/onboard?token=T');
    expect(claimed.public_key).toBeTruthy();
    expect(claimed.proof).toBeTruthy();
    const creds = JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8'));
    expect(creds.api_key).toBe('rgnt_agt_secret');
    expect(creds.agent_id).toBe('agent_x');
    expect(creds.signing_key_file).toBe(join(home, 'agent-key.json'));
    expect(lines.join('\n')).not.toContain('rgnt_agt_secret');
  });
});

describe('enroll', () => {
  it('registers the key under the invite and writes the credentials', async () => {
    const home = mkdtempSync(join(tmpdir(), 'regent-'));
    process.env.REGENT_HOME = home;
    let posted: any = null;
    const f = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/v1/enrol/rgnt_inv_good') && (!init || !init.method)) return res(200, { organization_id: 'org-1', agent_id: 'agent_y' });
      if (String(url).endsWith('/v1/enrol/rgnt_inv_good') && init?.method === 'POST') {
        posted = JSON.parse(String(init.body));
        return res(200, { organization_id: 'org-1', agent_id: 'agent_y', kid: posted.public_key && 'k', control_key: 'rgnt_agt_s2', control_url: 'https://gate.test', platform_url: 'https://api.test', require_signed_assertions: true });
      }
      return res(404, {});
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    expect(await enroll(['rgnt_inv_good', '--label', 'box'], { fetch: f, log: (s) => lines.push(s) })).toBe(0);
    expect(posted.label).toBe('box');
    const creds = JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8'));
    expect(creds.api_key).toBe('rgnt_agt_s2');
  });
});
