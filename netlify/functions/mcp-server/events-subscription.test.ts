import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalJson,
  computeSubscriptionId,
  generateNetlifySigningSecret,
  openRelayToken,
  parseRelayPath,
  relayPath,
  sealRelayToken,
  secureEquals,
} from './events/subscription.ts';

// Pin the dev-key path: a localhost issuer with no JWE_SECRET makes
// createJWE/decryptJWE use the fixed dev-only key.
process.env.OAUTH_ISSUER = 'http://localhost:8888';
delete process.env.JWE_SECRET;

const identity = {
  userId: 'user-1',
  eventName: 'deploy.started_failing',
  siteId: 'site-abc',
  filters: { context: 'production' },
  callbackUrl: 'https://example.com/cb/1',
};

test('canonicalJson sorts keys at every level and drops undefined', () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
    '{"a":{"c":3,"d":2},"b":1}',
  );
  // Key order in the input must not change the output — this is what stops two
  // identical subscriptions from being treated as different.
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonicalJson([3, { b: 1, a: 2 }]), '[3,{"a":2,"b":1}]');
});

test('computeSubscriptionId is deterministic and order-independent', () => {
  const a = computeSubscriptionId(identity);
  const b = computeSubscriptionId({ ...identity });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{32}$/);
});

test('computeSubscriptionId is unique per user', () => {
  // Two users watching the same site+event with the same callback must not
  // share a hook: unsubscribing one would otherwise silence the other.
  const asUserOne = computeSubscriptionId(identity);
  const asUserTwo = computeSubscriptionId({ ...identity, userId: 'user-2' });
  assert.notEqual(asUserOne, asUserTwo);
});

test('computeSubscriptionId varies with every identity component', () => {
  const base = computeSubscriptionId(identity);
  assert.notEqual(base, computeSubscriptionId({ ...identity, siteId: 'site-other' }));
  assert.notEqual(base, computeSubscriptionId({ ...identity, eventName: 'deploy.failed' }));
  assert.notEqual(base, computeSubscriptionId({ ...identity, callbackUrl: 'https://example.com/cb/2' }));
  assert.notEqual(base, computeSubscriptionId({ ...identity, filters: { context: 'deploy-preview' } }));
  assert.notEqual(base, computeSubscriptionId({ ...identity, filters: {} }));
});

test('relay tokens round-trip through seal/open', async () => {
  const subId = computeSubscriptionId(identity);
  const jwe = await sealRelayToken({
    subId,
    userId: identity.userId,
    eventName: identity.eventName,
    netlifyEvent: 'deploy_failed_after_succeeding',
    siteId: identity.siteId,
    filters: identity.filters,
    cb: identity.callbackUrl,
    whsec: 'whsec_' + Buffer.alloc(32, 7).toString('base64'),
    nsec: generateNetlifySigningSecret(),
  });

  const opened = await openRelayToken(jwe);
  assert.equal(opened.status, 'ok');
  assert.ok(opened.status === 'ok');
  assert.equal(opened.token.subId, subId);
  assert.equal(opened.token.userId, 'user-1');
  assert.equal(opened.token.netlifyEvent, 'deploy_failed_after_succeeding');
  assert.equal(opened.token.cb, identity.callbackUrl);
  assert.deepEqual(opened.token.filters, { context: 'production' });
});

test('a relay token is sealed with the events key, not the auth key', async () => {
  // The whole point of the separate key: an auth-key JWE must not open as a
  // relay token, and a relay token must not open with the auth key. If the two
  // keys were ever collapsed back into one, this fails.
  const { createJWE, decryptJWE, getEventsRelayKey } = await import('./utils.ts');

  const authKeyToken = await createJWE({ token_use: 'mcp_events_relay', v: 1 }, '1h');
  assert.deepEqual(
    await openRelayToken(authKeyToken), { status: 'unreadable' },
    'a token sealed with the auth key must not open as a relay token',
  );

  const relayToken = await sealRelayToken({
    subId: computeSubscriptionId(identity),
    userId: 'user-1', eventName: 'deploy.failed', netlifyEvent: 'deploy_failed',
    siteId: 'site-abc', filters: {}, cb: 'https://example.com/cb',
    whsec: 'whsec_x', nsec: 'n',
  });
  await assert.rejects(
    () => decryptJWE(relayToken),
    'a relay token must not open with the auth key',
  );
  // ...but it does open with its own key.
  assert.ok(await decryptJWE(relayToken, getEventsRelayKey()));
});

test('openRelayToken reports a bad token as unreadable, never as misconfigured', async () => {
  // This distinction is load-bearing: `unreadable` becomes a 410, which makes
  // Netlify DELETE the hook. Only a genuinely dead token may take that path.
  assert.deepEqual(await openRelayToken('not-a-jwe'), { status: 'unreadable' });
  assert.deepEqual(await openRelayToken(''), { status: 'unreadable' });
});

test('parseRelayPath accepts a well-formed path and rejects others', async () => {
  const subId = 'a'.repeat(32);
  const jwe = 'aaa.bbb.ccc.ddd.eee';
  const parsed = parseRelayPath(relayPath(subId, jwe));
  assert.deepEqual(parsed, { subId, jwe });

  assert.equal(parseRelayPath('/events/relay/short/abc'), null);
  assert.equal(parseRelayPath('/events/relay/' + subId), null);
  assert.equal(parseRelayPath('/mcp'), null);
  // Path traversal in the token segment must not parse.
  assert.equal(parseRelayPath(`/events/relay/${subId}/../../etc/passwd`), null);
});

test('secureEquals compares by value and tolerates length mismatch', () => {
  assert.equal(secureEquals('abc', 'abc'), true);
  assert.equal(secureEquals('abc', 'abd'), false);
  assert.equal(secureEquals('abc', 'abcd'), false);
  assert.equal(secureEquals('', ''), true);
});
