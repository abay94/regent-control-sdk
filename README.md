# @regent/control-sdk

TypeScript client for **Regent Control** — runtime policy enforcement for an AI agent's
actions. Authorize each action (**allow / deny / escalate**), get a short-lived scoped
token, perform it, report the outcome.

```bash
npm install @regent/control-sdk
```

Node 18+ (uses the built-in `fetch` + Web Crypto). Zero runtime dependencies.

## Usage — gate-direct

```ts
import { RegentControl, ControlDenied } from '@regent/control-sdk';

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

## Request signing (optional)

Pass `agentSecret` to HMAC-sign the request body (`X-Agent-Signature`), with the per-agent
secret `HMAC-SHA256(apiKey, agentId)` (`deriveAgentSecret`) — identical to the Python SDK,
so an agent moves between them unchanged.

## Decision codes

`IDENTITY_NOT_RESOLVED` · `AGENT_NOT_ACTIVE` · `POLICY_DENIED` · `TOOL_NOT_ALLOWED` ·
`MANDATE_NOT_FOUND` · `MANDATE_LIMIT_EXCEEDED` · `RISK_THRESHOLD_EXCEEDED` ·
`ESCALATION_REQUIRED` · `INTERNAL_ERROR`. See the
[integration quickstart](../regent-control-docs/regent-control-sdk-quickstart.md) for the
full error contract, the human-in-the-loop (escalation) flow, and the agent contract.

The Python SDK (`regent-control`) adds a sidecar-routing client, a `@guarded` decorator, a
`regent dev` mock, and a service-side scoped-token verifier.
