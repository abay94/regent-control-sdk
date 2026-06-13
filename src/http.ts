/**
 * Internal HTTP helper. Not part of the public surface.
 *
 * - Bearer API key auth; optional HMAC-SHA256 body signing (X-Agent-Signature).
 * - Retries network errors / 429 / 5xx with exponential backoff.
 * - A 200 response carrying a `deny` decision is NOT an error — it's returned
 *   to the caller. Only transport/auth/validation failures throw.
 * @internal
 */

import { ControlError, ControlNetworkError } from './errors.js';

export interface HttpConfig {
  baseUrl: string;
  apiKey: string;
  agentSecret?: string;
  timeoutMs: number;
  maxRetries: number;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class HttpClient {
  readonly #cfg: HttpConfig;

  constructor(cfg: HttpConfig) {
    this.#cfg = { ...cfg, baseUrl: cfg.baseUrl.replace(/\/$/, '') };
  }

  async post<T>(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const url = `${this.#cfg.baseUrl}${path}`;
    const payload = JSON.stringify(body ?? {});

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${this.#cfg.apiKey}`,
      ...extraHeaders,
    };
    if (this.#cfg.agentSecret) {
      const sig = await hmacSha256Hex(this.#cfg.agentSecret, payload);
      headers['X-Agent-Signature'] = `hmac-sha256=${sig}`;
      headers['X-Agent-Signature-Timestamp'] = String(Math.floor(Date.now() / 1000));
    }

    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= this.#cfg.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#cfg.timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: payload,
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.ok) {
          return (await res.json()) as T;
        }
        if (RETRYABLE.has(res.status) && attempt < this.#cfg.maxRetries) {
          await sleep(2 ** attempt * 100);
          continue;
        }
        await this.#throw(res, url);
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof ControlError) throw err; // a thrown API error — don't retry
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.#cfg.maxRetries) {
          await sleep(2 ** attempt * 100);
          continue;
        }
        throw new ControlNetworkError(`Request to ${url} failed`, lastErr);
      }
    }
    throw new ControlNetworkError(`Request to ${url} failed`, lastErr);
  }

  async get<T>(path: string): Promise<T> {
    const url = `${this.#cfg.baseUrl}${path}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) await this.#throw(res, url);
    return (await res.json()) as T;
  }

  async #throw(res: Response, url: string): Promise<never> {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string; detail?: string };
      detail = body.detail ?? body.error ?? '';
    } catch {
      // ignore parse failure
    }
    throw new ControlError(`HTTP ${res.status} ${res.statusText} at ${url}${detail ? `: ${detail}` : ''}`, {
      statusCode: res.status,
      requestId: res.headers.get('x-request-id') ?? undefined,
    });
  }
}
