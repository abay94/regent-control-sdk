// The agent's own Ed25519 key, in the same file format the Python SDK writes
// (~/.regent/agent-key.json: private_key / public_key as base64url raw 32 bytes, kid = RFC 7638
// thumbprint), so a machine can switch between `pip` and `npx` without re-enrolling.
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PROOF_V1 = 'regent-agent-key-v1';
export const DEFAULT_PLATFORM_URL = 'https://api.regentprotocol.org';

export interface AgentKey {
  private_key: string; // base64url raw 32 bytes
  public_key: string; // base64url raw 32 bytes
  kid: string;
}

export function regentHome(): string {
  return process.env.REGENT_HOME || join(homedir(), '.regent');
}

export function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function kidFor(publicKeyB64url: string): string {
  // canonical JWK, keys sorted, no spaces — byte-identical to the Python side
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${publicKeyB64url}"}`;
  return b64url(createHash('sha256').update(canonical).digest());
}

export function generateAgentKey(): AgentKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
  const pub = publicKey.export({ format: 'jwk' }) as { x: string };
  return { private_key: priv.d, public_key: pub.x, kid: kidFor(pub.x) };
}

export function proofOfPossession(key: AgentKey, orgId: string, agentId: string): string {
  const pk = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: key.private_key, x: key.public_key },
    format: 'jwk',
  });
  const message = Buffer.from(`${PROOF_V1}\n${orgId}\n${agentId}\n${key.kid}`);
  return b64url(sign(null, message, pk));
}

export function readKeyFile(path: string): AgentKey {
  const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<AgentKey>;
  if (!data.private_key || !data.public_key) throw new Error(`${path}: not an agent key file`);
  return { private_key: data.private_key, public_key: data.public_key, kid: data.kid || kidFor(data.public_key) };
}

function writePrivate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  try {
    chmodSync(path, 0o600);
  } catch {
    /* windows */
  }
}

export function loadOrCreateKey(path: string): { key: AgentKey; created: boolean } {
  if (existsSync(path)) return { key: readKeyFile(path), created: false };
  const key = generateAgentKey();
  writePrivate(path, key);
  return { key, created: true };
}

export interface Credentials {
  api_key: string;
  agent_id: string;
  organization_id?: string;
  base_url: string;
  platform_url: string;
  signing_key_file?: string;
}

export function writeCredentials(path: string, creds: Credentials): void {
  writePrivate(path, creds);
}
