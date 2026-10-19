# @regent-protocol/control-sdk

TypeScript client for **Regent Control** — runtime policy enforcement for an AI agent's
actions. Authorize each action (**allow / deny / escalate**), get a short-lived scoped
token, perform it, report the outcome.

```bash
npm install @regent-protocol/control-sdk
```

Node 18+ (uses the built-in `fetch` + Web Crypto). Zero runtime dependencies.

## Usage — gate-direct

```ts
import { RegentControl, ControlDenied } from '@regent-protocol/control-sdk';

const control = new RegentControl({ apiKey: 'rgnt_ctrl_…', agentId: 'agent_refund_bot' });

const d = await control.authorize({
  tool: 'payments',
  action: 'refund.create',
  context: {
    amountUsd: 50,
    mandateId: 'mnd_support_refunds',
    idempotencyKey: 'T-8842:ch_aaa',   // a retry won't double-refund
    userToken: repIdToken,             // the human's OIDC token — verified by the gate
    intent: 'refund the duplicate charge on ticket 8842',
    accountStatus: 'active',
    refundToOriginal: true,            // verified facts the policy keys on
  },
});

if (!d.allowed) throw new ControlDenied(d.code, d.reason, d.decisionId);
await doRefund(d.token);               // the scoped token authorizes the downstream call
await control.complete(d.decisionId, { status: 'success', downstreamRef: refundId });
```

A `deny`/`escalate` is a **normal return value** (`d.allowed === false`), not a thrown
error — branch on `d.code`. `ControlError` (transport/auth/5xx) and `ControlNetworkError`
(never reached the plane) *are* thrown; the gate fails **closed**.

## Context fields

`context` is camelCase and translated to the wire contract automatically:
`sessionId`, `userRef`, `amountUsd`, `mandateId`, `idempotencyKey`, `userToken`, `intent`,
`reasoningSummary`, `task`, `op`, `resourceType`, `accountStatus`, `refundToOriginal`, plus
any extra keys (passed through verbatim).

## The agent's own key (RFC 9421)

`npx @regent-protocol/control-sdk enroll rgnt_inv_…` (or `onboard --name "…"`) generates the
agent's Ed25519 key, registers it and writes `~/.regent/credentials.json`. A client built
from that file signs every request with the key — `Signature-Input`, `Signature`,
`Content-Digest`, tag `regent-agent`, the same bytes the Python SDK emits — and the receipts
name the agent's key:

```ts
const control = RegentControl.fromCredentials();          // ~/.regent/credentials.json + agent-key.json
// or: new RegentControl({ apiKey, agentId, signingKeyFile: '~/.regent/agent-key.json' })
```

## Gateway tools — `gateway()`

Tools behind the Cloud Gateway (Agentcard, Stripe through the vault, any catalog tool) are
one call from the same client. The gate decides first; on allow you get the provider's
response, on a refusal the verdict — a refusal is a value, not a thrown error:

```ts
const cart = await control.gateway('agentcard_shop', 'buy', {
  body: { ask: 'one pack of AA batteries from Amazon, cheapest' }, intent: 'batteries for the office',
});
const { conversation_id, carts } = cart.data as { conversation_id: string; carts: { hash: string }[] };
const order = await control.gateway('agentcard_buy', 'buy', {
  body: { conversation_id, confirm: carts[0].hash }, idempotencyKey: 'batt-1',
});
if (order.escalated) { /* a person approves under Approvals; repeat with the same idempotencyKey */ }
```

When the client holds the agent's key the gateway request is signed with it; the gateway
verifies the signature and the gate records the agent's key. `gatewayUrl` defaults to
`https://gw.regentprotocol.org` (or `gateway_url` in `credentials.json`).

## HMAC signing (legacy, optional)

Pass `agentSecret` to HMAC-sign the request body (`X-Agent-Signature`), with the per-agent
secret `HMAC-SHA256(apiKey, agentId)` (`deriveAgentSecret`). The agent's own key replaces it.

## Decision codes

`IDENTITY_NOT_RESOLVED` · `AGENT_NOT_ACTIVE` · `POLICY_DENIED` · `TOOL_NOT_ALLOWED` ·
`MANDATE_NOT_FOUND` · `MANDATE_LIMIT_EXCEEDED` · `RISK_THRESHOLD_EXCEEDED` ·
`ESCALATION_REQUIRED` · `INTERNAL_ERROR`. See the
[integration quickstart](../regent-control-docs/regent-control-sdk-quickstart.md) for the
full error contract, the human-in-the-loop (escalation) flow, and the agent contract.

The Python SDK (`regent-control`) adds a sidecar-routing client, a `@guarded` decorator, a
`regent dev` mock, and a service-side scoped-token verifier.
