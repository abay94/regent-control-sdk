// HMAC helpers (Web Crypto — works in Node 18+ and browsers).

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * The per-agent HMAC secret used for request signing.
 * Must match the server: HMAC-SHA256(apiKey, agentId).
 */
export async function deriveAgentSecret(apiKey: string, agentId: string): Promise<string> {
  return hmacSha256Hex(apiKey, agentId);
}
