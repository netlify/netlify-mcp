// End-to-end through the relay handler: seal a real subscription token, sign a
// body the way bitballoon's Hook::HttpTrigger does, and assert what the
// subscriber receives and what Netlify is told.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';

// A non-localhost issuer, so relay URLs look like production ones — which means
// the real key path applies and both secrets must be set. Relay tokens use
// EVENTS_RELAY_JWE_SECRET, deliberately distinct from the auth JWE_SECRET.
process.env.OAUTH_ISSUER = 'https://mcp.example.com';
process.env.JWE_SECRET = 'test-only-auth-jwe-secret-at-least-32-chars';
process.env.EVENTS_RELAY_JWE_SECRET = 'test-only-events-relay-secret-at-least-32-chars';

import relay from '../events-relay.ts';
import {
  computeSubscriptionId,
  relayPath,
  sealRelayToken,
} from './events/subscription.ts';

const WHSEC = 'whsec_' + Buffer.alloc(32, 5).toString('base64');
const NSEC = 'netlify-signing-secret';
// A hostname: the callback guard refuses IP literals.
const CALLBACK = 'https://example.com/cb';

const realFetch = globalThis.fetch;
let delivered: Array<{ url: string; headers: Record<string, string>; body: any }> = [];

const fakeContext = {} as any;

function stubSubscriber(status = 200) {
  delivered = [];
  globalThis.fetch = (async (input: any, init: any) => {
    delivered.push({
      url: String(input),
      headers: { ...(init?.headers ?? {}) },
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    return new Response('', { status });
  }) as typeof fetch;
}

/** Reproduces Hook::HttpTrigger.sign: HS256 JWT over {iss, sha256(body)}. */
function netlifySign(body: string, secret = NSEC): string {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'netlify',
    sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
  })).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

const IDENTITY = {
  userId: 'user-1',
  eventName: 'deploy.failed',
  siteId: 'site-abc',
  filters: {} as { branch?: string; context?: string },
  callbackUrl: CALLBACK,
};

async function buildRelayUrl(overrides: Partial<Parameters<typeof sealRelayToken>[0]> = {}, identity = IDENTITY) {
  const subId = computeSubscriptionId(identity);
  const jwe = await sealRelayToken({
    subId,
    userId: identity.userId,
    eventName: identity.eventName,
    netlifyEvent: 'deploy_failed',
    siteId: identity.siteId,
    filters: identity.filters,
    cb: identity.callbackUrl,
    whsec: WHSEC,
    nsec: NSEC,
    subExp: Date.now() + 60_000,
    ...overrides,
  });
  return { subId, url: `https://mcp.example.com${relayPath(subId, jwe)}` };
}

const DEPLOY_BODY = JSON.stringify({
  id: 'deploy-1',
  site_id: 'site-abc',
  name: 'my-site',
  state: 'error',
  error_message: 'Build failed',
  branch: 'main',
  context: 'production',
  admin_url: 'https://app.netlify.com/sites/my-site/deploys/deploy-1',
  file_configuration: { build: { command: 'npm run build' } },
  required: ['sha1', 'sha2'],
});

function netlifyPost(url: string, body: string, signature?: string | null) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Netlify-Event': 'deploy_failed',
  };
  const sig = signature === undefined ? netlifySign(body) : signature;
  if (sig) headers['x-webhook-signature'] = sig;
  return new Request(url, { method: 'POST', headers, body });
}

beforeEach(() => { delivered = []; });
afterEach(() => { globalThis.fetch = realFetch; });

test('relay forwards a signed delivery to the subscriber', async () => {
  stubSubscriber();
  const { subId, url } = await buildRelayUrl();

  const response = await relay(netlifyPost(url, DEPLOY_BODY), fakeContext);
  assert.equal(response.status, 202);
  assert.equal(delivered.length, 1);

  const sent = delivered[0];
  assert.equal(sent.url, CALLBACK);
  assert.equal(sent.headers['X-MCP-Subscription-Id'], subId);
  assert.match(sent.headers['webhook-signature'], /^v1,/);
  // The envelope shape the extension specifies.
  assert.equal(sent.body.name, 'deploy.failed');
  assert.equal(sent.body.cursor, null);
  assert.ok(sent.body.timestamp);
  assert.equal(sent.body.data.deploy_id, 'deploy-1');
  assert.equal(sent.body.data.error_message, 'Build failed');
});

test('relay projects away build configuration before forwarding', async () => {
  stubSubscriber();
  const { url } = await buildRelayUrl();
  await relay(netlifyPost(url, DEPLOY_BODY), fakeContext);

  assert.equal('file_configuration' in delivered[0].body.data, false);
  assert.equal('required' in delivered[0].body.data, false);
});

test('relay stamps an event id derived from the deploy, so retries dedupe', async () => {
  stubSubscriber();
  const { subId, url } = await buildRelayUrl();
  await relay(netlifyPost(url, DEPLOY_BODY), fakeContext);
  const first = delivered[0].body.eventId;
  assert.equal(first, `evt_${subId}_deploy_failed_deploy-1`);

  // Netlify re-delivering the same event (its own sidekiq retry) must produce
  // the same id, even across a cold start — hence derived, not random.
  delivered = [];
  await relay(netlifyPost(url, DEPLOY_BODY), fakeContext);
  assert.equal(delivered[0].body.eventId, first);
});

test('relay rejects a delivery with no signature', async () => {
  stubSubscriber();
  const { url } = await buildRelayUrl();
  const response = await relay(netlifyPost(url, DEPLOY_BODY, null), fakeContext);
  assert.equal(response.status, 401);
  assert.equal(delivered.length, 0);
});

test('relay rejects a delivery signed with the wrong secret', async () => {
  stubSubscriber();
  const { url } = await buildRelayUrl();
  const forged = netlifySign(DEPLOY_BODY, 'not-the-hook-secret');
  const response = await relay(netlifyPost(url, DEPLOY_BODY, forged), fakeContext);
  assert.equal(response.status, 401);
  assert.equal(delivered.length, 0);
});

test('relay rejects a body altered after signing', async () => {
  stubSubscriber();
  const { url } = await buildRelayUrl();
  const signature = netlifySign(DEPLOY_BODY);
  const tampered = DEPLOY_BODY.replace('"state":"error"', '"state":"ready"');
  const response = await relay(netlifyPost(url, tampered, signature), fakeContext);
  assert.equal(response.status, 401);
  assert.equal(delivered.length, 0);
});

test('relay returns 410 for an unreadable token so the hook is destroyed', async () => {
  stubSubscriber();
  const url = `https://mcp.example.com${relayPath('a'.repeat(32), 'not.a.real.jwe.token')}`;
  const response = await relay(netlifyPost(url, DEPLOY_BODY), fakeContext);
  assert.equal(response.status, 410);
  assert.equal(delivered.length, 0);
});

test('relay returns 410 when the path subId does not match the sealed one', async () => {
  stubSubscriber();
  const { url } = await buildRelayUrl();
  // Swap the path's subId for a different one while keeping the real token.
  const mismatched = url.replace(/\/events\/relay\/[0-9a-f]{32}\//, `/events/relay/${'f'.repeat(32)}/`);
  const response = await relay(netlifyPost(mismatched, DEPLOY_BODY), fakeContext);
  assert.equal(response.status, 410);
  assert.equal(delivered.length, 0);
});

test('relay 404s a malformed path without touching hook state', async () => {
  stubSubscriber();
  const response = await relay(netlifyPost('https://mcp.example.com/events/relay/short/x', DEPLOY_BODY), fakeContext);
  // Not a 410: we must not destroy a hook just because a path was odd.
  assert.equal(response.status, 404);
});

test('relay applies the context filter Netlify cannot', async () => {
  stubSubscriber();
  const { url } = await buildRelayUrl(
    {},
    { ...IDENTITY, filters: { context: 'deploy-preview' } },
  );
  // The payload is a production deploy; the subscription only wants previews.
  const response = await relay(netlifyPost(url, DEPLOY_BODY), fakeContext);
  assert.equal(response.status, 202);
  assert.equal(delivered.length, 0, 'filtered out, and the hook stays healthy');
});

test('relay applies the branch filter', async () => {
  stubSubscriber();
  const { url } = await buildRelayUrl({}, { ...IDENTITY, filters: { branch: 'main' } });
  await relay(netlifyPost(url, DEPLOY_BODY), fakeContext);
  assert.equal(delivered.length, 1, 'branch main matches');

  delivered = [];
  const other = await buildRelayUrl({}, { ...IDENTITY, filters: { branch: 'release' } });
  await relay(netlifyPost(other.url, DEPLOY_BODY), fakeContext);
  assert.equal(delivered.length, 0);
});

test('relay passes a subscriber 410 back to netlify', async () => {
  stubSubscriber(410);
  const { url } = await buildRelayUrl();
  const response = await relay(netlifyPost(url, DEPLOY_BODY), fakeContext);
  assert.equal(response.status, 410, 'lets Netlify garbage-collect the hook');
});

test('relay rejects non-POST methods', async () => {
  const response = await relay(new Request('https://mcp.example.com/events/relay/x/y', { method: 'GET' }), fakeContext);
  assert.equal(response.status, 405);
});

test('relay stops delivering once the promised window has passed', async () => {
  // The spec requires delivery to stop at refreshBefore. Before this, the
  // relay kept going for the full life of the token, so a subscription nobody
  // refreshed leaked a site's activity for weeks past its stated expiry — to a
  // subscriber who may since have lost access to the site.
  stubSubscriber();
  const { url } = await buildRelayUrl({ subExp: Date.now() - 1 });

  const response = await relay(netlifyPost(url, DEPLOY_BODY), fakeContext);
  assert.equal(response.status, 410, '410 also has Netlify delete the hook');
  assert.equal(delivered.length, 0, 'nothing may be forwarded after expiry');
  assert.match(await response.clone().text(), /expired/);
});

test('relay still delivers just inside the window', async () => {
  stubSubscriber();
  const { url } = await buildRelayUrl({ subExp: Date.now() + 60_000 });
  const response = await relay(netlifyPost(url, DEPLOY_BODY), fakeContext);
  assert.equal(response.status, 202);
  assert.equal(delivered.length, 1);
});
