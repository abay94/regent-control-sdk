// RFC 9421 HTTP Message Signatures with the agent's own Ed25519 key — byte-identical to the
// Python SDK (regent_control.crypto.sign_request_rfc9421), so the gate, the gateway and any
// RFC 9421 library verify both the same way:
//
//   Content-Digest:  sha-256=:<base64(sha256(body))>:
//   Signature-Input: regent=("@method" "@authority" "@path" "content-digest");created=<unix>;keyid="<kid>";alg="ed25519";tag="regent-agent"
//   Signature:       regent=:<base64(signature)>:
import { createHash, createPrivateKey, sign } from 'node:crypto';
import type { AgentKey } from './agentkey.js';

export const SIGNATURE_LABEL = 'regent';
export const SIGNATURE_TAG = 'regent-agent';

/** RFC 9530 `Content-Digest` of a body. */
export function contentDigest(body: Uint8Array | string): string {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

/** `@authority` as the server sees it: lowercase host, port only when not the scheme's default. */
export function authorityOf(url: string): string {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  if (!u.port) return host;
  const dflt = u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '';
  return u.port === dflt ? host : `${host}:${u.port}`;
}

/** RFC 9421 §2.5: one line per covered component, then `@signature-params`. */
export function signatureBase(
  method: string,
  url: string,
  headers: Record<string, string>,
  covered: readonly string[],
  params: string,
): string {
  const u = new URL(url);
  const lines: string[] = [];
  for (const component of covered) {
    let value: string;
    if (component === '@method') value = method.toUpperCase();
    else if (component === '@authority') value = authorityOf(url);
    else if (component === '@path') value = u.pathname || '/';
    else if (component === '@query') value = u.search || '?';
    else if (component.startsWith('@')) throw new Error(`unsupported derived component ${component}`);
    else {
      const found = Object.entries(headers).find(([k]) => k.toLowerCase() === component);
      if (!found) throw new Error(`covered header ${component} is not set`);
      value = found[1];
    }
    lines.push(`"${component}": ${value}`);
  }
  lines.push(`"@signature-params": ${params}`);
  return lines.join('\n');
}

/**
 * Headers that sign `method url body` with the agent's key: `Content-Digest` (when there is
 * a body), `Signature-Input` and `Signature`. The same profile the Python SDK emits.
 */
export function signRequest(
  key: AgentKey,
  method: string,
  url: string,
  body: Uint8Array | string = '',
  created: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const pk = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: key.private_key, x: key.public_key },
    format: 'jwk',
  });
  const covered: string[] = ['@method', '@authority', '@path'];
  const headers: Record<string, string> = {};
  const hasBody = typeof body === 'string' ? body.length > 0 : body.byteLength > 0;
  if (hasBody) {
    headers['Content-Digest'] = contentDigest(body);
    covered.push('content-digest');
  }
  const params =
    '(' + covered.map((c) => `"${c}"`).join(' ') + `);created=${created};keyid="${key.kid}";alg="ed25519";tag="${SIGNATURE_TAG}"`;
  const base = signatureBase(method, url, headers, covered, params);
  const signature = sign(null, Buffer.from(base, 'utf8'), pk);
  headers['Signature-Input'] = `${SIGNATURE_LABEL}=${params}`;
  headers['Signature'] = `${SIGNATURE_LABEL}=:${signature.toString('base64')}:`;
  return headers;
}
