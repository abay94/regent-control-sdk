#!/usr/bin/env node
// `npx @regent-protocol/control-sdk onboard --name "…"` and `… enroll <code>` for machines
// that have Node and not Python (Grok Bot, Muse, your own agent). Same servers, same files.
import { join } from 'node:path';
import {
  DEFAULT_PLATFORM_URL,
  loadOrCreateKey,
  proofOfPossession,
  regentHome,
  writeCredentials,
} from './agentkey.js';

type Fetch = typeof fetch;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function json(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}

export async function onboard(args: string[], deps: { fetch?: Fetch; sleep?: (ms: number) => Promise<void>; log?: (s: string) => void } = {}): Promise<number> {
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log ?? console.log;
  const name = arg(args, '--name');
  if (!name) {
    log('usage: onboard --name "<how the person will see this agent>" [--vendor X] [--purpose Y] [--platform-url U] [--no-key] [--timeout SECONDS]');
    return 2;
  }
  const platform = (arg(args, '--platform-url') || process.env.REGENT_PLATFORM_URL || DEFAULT_PLATFORM_URL).replace(/\/$/, '');
  const body: Record<string, string> = { agent_name: name };
  for (const [k, flag] of [['vendor', '--vendor'], ['purpose', '--purpose'], ['model_vendor', '--model-vendor'], ['framework', '--framework']] as const) {
    const v = arg(args, flag);
    if (v) body[k] = v;
  }
  const started = await f(`${platform}/v1/onboard`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (started.status !== 201) {
    log(`onboarding could not start: ${started.status} ${JSON.stringify(await json(started)).slice(0, 200)}`);
    return 1;
  }
  const st = await json(started);
  const code: string = st.poll_code;
  log('Ask the person to open this link and confirm the budget (valid 15 minutes):');
  log(`  ${st.onboard_url}`);
  log('Waiting for their confirmation…');
  const interval = Math.max(1, Number(st.poll_interval) || 5) * 1000;
  const deadline = Date.now() + Math.max(30, Number(arg(args, '--timeout') || 900)) * 1000;
  let status = 'pending';
  let last: any = {};
  while (Date.now() < deadline) {
    const r = await f(`${platform}/v1/onboard/claim/${code}`);
    last = await json(r);
    status = last.status || 'pending';
    if (status !== 'pending') break;
    await sleep(interval);
  }
  if (status !== 'approved') {
    log(`not approved: ${status}`);
    return 2;
  }
  const home = regentHome();
  const keyPath = arg(args, '--key-file') || join(home, 'agent-key.json');
  const credPath = arg(args, '--credentials') || join(home, 'credentials.json');
  const claim: Record<string, string> = {};
  const label = arg(args, '--label');
  if (label) claim.label = label;
  let signed = false;
  if (!args.includes('--no-key')) {
    const { key, created } = loadOrCreateKey(keyPath);
    log(`${created ? 'generated the agent\'s key at' : 'using the key at'} ${keyPath} (kid ${key.kid.slice(0, 16)}…)`);
    claim.public_key = key.public_key;
    claim.proof = proofOfPossession(key, last.organization_id, last.agent_id);
    signed = true;
  }
  const c = await f(`${platform}/v1/onboard/claim/${code}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(claim) });
  if (c.status !== 200) {
    log(`claim failed: ${c.status} ${JSON.stringify(await json(c)).slice(0, 300)}`);
    return 1;
  }
  const out = await json(c);
  writeCredentials(credPath, {
    api_key: out.control_key,
    agent_id: out.agent_id,
    organization_id: out.organization_id,
    base_url: out.control_url || 'https://control-api.regentprotocol.org',
    platform_url: out.platform_url || platform,
    ...(signed ? { signing_key_file: keyPath } : {}),
  });
  log(`onboarded: agent ${out.agent_id} in organization ${out.organization_id} (${out.environment || '?'})${out.kid ? `, key ${out.kid} registered (signed requests required)` : ', bearer credential'}`);
  log(`credentials written to ${credPath} (a control key bound to this agent only)`);
  return 0;
}

export async function enroll(args: string[], deps: { fetch?: Fetch; log?: (s: string) => void } = {}): Promise<number> {
  const f = deps.fetch ?? fetch;
  const log = deps.log ?? console.log;
  const code = args.find((a) => a.startsWith('rgnt_inv_'));
  if (!code) {
    log('usage: enroll rgnt_inv_<code> [--label X] [--platform-url U]');
    return 2;
  }
  const platform = (arg(args, '--platform-url') || process.env.REGENT_PLATFORM_URL || DEFAULT_PLATFORM_URL).replace(/\/$/, '');
  const info = await f(`${platform}/v1/enrol/${code}`);
  if (info.status !== 200) {
    log(`invite not usable: ${info.status} ${JSON.stringify(await json(info)).slice(0, 200)}`);
    return 1;
  }
  const inv = await json(info);
  const home = regentHome();
  const keyPath = arg(args, '--key-file') || join(home, 'agent-key.json');
  const credPath = arg(args, '--credentials') || join(home, 'credentials.json');
  const { key, created } = loadOrCreateKey(keyPath);
  log(`${created ? 'generated the agent\'s key at' : 'using the key at'} ${keyPath} (kid ${key.kid.slice(0, 16)}…)`);
  const label = arg(args, '--label');
  const r = await f(`${platform}/v1/enrol/${code}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_key: key.public_key, proof: proofOfPossession(key, inv.organization_id, inv.agent_id), ...(label ? { label } : {}) }),
  });
  if (r.status !== 200) {
    log(`enrolment failed: ${r.status} ${JSON.stringify(await json(r)).slice(0, 300)}`);
    return 1;
  }
  const out = await json(r);
  writeCredentials(credPath, {
    api_key: out.control_key, agent_id: out.agent_id, organization_id: out.organization_id,
    base_url: out.control_url || 'https://control-api.regentprotocol.org', platform_url: out.platform_url || platform,
    signing_key_file: keyPath,
  });
  log(`enrolled: kid ${out.kid} registered for ${out.agent_id}${out.require_signed_assertions ? ' (signed requests required)' : ''}`);
  log(`credentials written to ${credPath} (a control key bound to this agent only)`);
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'onboard') return onboard(rest);
  if (cmd === 'enroll') return enroll(rest);
  console.log('regent-control (node): commands: onboard --name "…" | enroll rgnt_inv_…');
  return cmd ? 2 : 0;
}

const invokedDirectly = process.argv[1] && /(^|[\\/])cli\.js$/.test(process.argv[1]);
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
}
