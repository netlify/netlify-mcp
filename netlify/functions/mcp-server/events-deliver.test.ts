import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { deliverEvent } from './events/deliver.ts';
import { findHookBySubscriptionId, type NetlifyHook } from './events/hooks-api.ts';

const WHSEC = 'whsec_' + Buffer.alloc(32, 3).toString('base64');
// A literal public IP, so the SSRF guard passes without a DNS lookup.
const CALLBACK = 'https://1.1.1.1/cb';

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];

function stubFetch(responder: (attempt: number) => Response | Promise<Response> | Error) {
  calls = [];
  globalThis.fetch = (async (input: any, init: any) => {
    calls.push({
      url: String(input),
      headers: { ...(init?.headers ?? {}) },
      body: String(init?.body ?? ''),
    });
    const result = await responder(calls.length);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof fetch;
}

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

const deliver = () => deliverEvent({
  callbackUrl: CALLBACK,
  secret: WHSEC,
  subscriptionId: 'sub_1',
  eventId: 'evt_1',
  body: JSON.stringify({ eventId: 'evt_1', name: 'deploy.failed' }),
});

test('a 2xx on the first attempt reports 202 to netlify', async () => {
  stubFetch(() => new Response('', { status: 200 }));
  const outcome = await deliver();
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.relayStatus, 202);
  assert.equal(calls.length, 1);
});

test('the delivery is signed and carries the subscription id', async () => {
  stubFetch(() => new Response('', { status: 200 }));
  await deliver();
  const headers = calls[0].headers;
  assert.equal(headers['webhook-id'], 'evt_1');
  assert.equal(headers['X-MCP-Subscription-Id'], 'sub_1');
  assert.match(headers['webhook-signature'], /^v1,/);
  assert.ok(headers['webhook-timestamp']);
});

test('a 410 is passed through so netlify destroys the hook', async () => {
  // This is the self-cleaning path: Hook#process_http_response destroys a hook
  // whose endpoint answers 410, so a dead subscription stops firing on its own.
  stubFetch(() => new Response('', { status: 410 }));
  const outcome = await deliver();
  assert.equal(outcome.relayStatus, 410);
  assert.equal(outcome.delivered, false);
  assert.equal(calls.length, 1, '410 must not be retried');
});

test('a 413 is never retried and does not blame netlify', async () => {
  stubFetch(() => new Response('', { status: 413 }));
  const outcome = await deliver();
  assert.equal(calls.length, 1);
  assert.equal(outcome.relayStatus, 202, 'a too-large payload is our bug, not a transient fault');
  assert.equal(outcome.reason, 'too-large');
});

test('a non-410/413 4xx is not retried', async () => {
  stubFetch(() => new Response('', { status: 400 }));
  const outcome = await deliver();
  assert.equal(calls.length, 1);
  assert.equal(outcome.relayStatus, 202);
  assert.equal(outcome.reason, 'client-error');
});

test('a 5xx is retried and can still succeed', async () => {
  stubFetch((attempt) => new Response('', { status: attempt < 3 ? 503 : 200 }));
  const outcome = await deliver();
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.attempts, 3);
  assert.equal(outcome.relayStatus, 202);
});

test('a connection error is retried', async () => {
  stubFetch((attempt) => (attempt === 1 ? new Error('ECONNRESET') : new Response('', { status: 200 })));
  const outcome = await deliver();
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.attempts, 2);
});

test('the event id is stable across retries while the signature is not', async () => {
  stubFetch((attempt) => new Response('', { status: attempt < 3 ? 503 : 200 }));
  await deliver();
  const ids = calls.map((c) => c.headers['webhook-id']);
  assert.deepEqual(ids, ['evt_1', 'evt_1', 'evt_1'], 'subscribers dedupe on this');
  // Signatures are regenerated per attempt because the timestamp is.
  const signatures = new Set(calls.map((c) => c.headers['webhook-signature']));
  assert.ok(signatures.size >= 2, 'each attempt must carry a fresh signature');
});

test('exhausting the retries defers to netlify with a 503', async () => {
  stubFetch(() => new Response('', { status: 500 }));
  const outcome = await deliver();
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.attempts, 3, 'one inline attempt plus two retries');
  assert.equal(
    outcome.relayStatus, 503,
    'handing the failure back lets Netlify re-queue it rather than losing the event',
  );
});

test('delivery never follows a redirect', async () => {
  stubFetch(() => new Response('', { status: 200 }));
  globalThis.fetch = (async (input: any, init: any) => {
    assert.equal(init?.redirect, 'error', 'a redirect could leave the vetted host');
    return new Response('', { status: 200 });
  }) as typeof fetch;
  await deliver();
});

test('a callback pointing at private address space is dropped, not retried', async () => {
  stubFetch(() => new Response('', { status: 200 }));
  const outcome = await deliverEvent({
    callbackUrl: 'https://169.254.169.254/cb',
    secret: WHSEC,
    subscriptionId: 'sub_1',
    eventId: 'evt_1',
    body: '{}',
  });
  assert.equal(outcome.attempts, 0);
  assert.equal(calls.length, 0, 'the request must never be made');
  assert.equal(outcome.reason, 'private-address');
  // 202 keeps the hook alive so a re-pointed DNS record can recover.
  assert.equal(outcome.relayStatus, 202);
});

// --- subscription lookup ----------------------------------------------------

test('findHookBySubscriptionId matches on the subId segment, not the whole URL', () => {
  const subId = 'a'.repeat(32);
  const hooks: NetlifyHook[] = [
    { id: 'h1', site_id: 's', type: 'url', event: 'deploy_failed',
      data: { url: 'https://mcp.example.com/events/relay/' + 'b'.repeat(32) + '/OLDJWE' } },
    { id: 'h2', site_id: 's', type: 'url', event: 'deploy_failed',
      data: { url: `https://mcp.example.com/events/relay/${subId}/SOME.OLD.JWE` } },
  ];

  // The token segment changes every time the client rotates its secret on
  // refresh, so matching the whole URL would orphan the old hook and create a
  // duplicate. Matching the subId finds it.
  const found = findHookBySubscriptionId(hooks, subId);
  assert.equal(found?.id, 'h2');

  assert.equal(findHookBySubscriptionId(hooks, 'c'.repeat(32)), undefined);
  assert.equal(findHookBySubscriptionId([], subId), undefined);
  // A hook with no url (e.g. an email hook on the same event) must not match.
  assert.equal(findHookBySubscriptionId([{ id: 'h3', site_id: 's', type: 'email', event: 'deploy_failed' }], subId), undefined);
});
