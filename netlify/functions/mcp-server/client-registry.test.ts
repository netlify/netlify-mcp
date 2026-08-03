import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createStatelessClientId,
  inferApplicationType,
  isRedirectUriAllowed,
  resolveClient,
} from './client-registry.ts';
import { staticClients } from './oauth-clients.ts';

// These tests run against the localhost dev key (no OAUTH_ISSUER / JWE_SECRET
// set), which is exactly the stateless round-trip we depend on in production.

test('inferApplicationType: loopback and custom-scheme redirects are native', () => {
  assert.equal(inferApplicationType(['http://localhost:8080/cb']), 'native');
  assert.equal(inferApplicationType(['http://127.0.0.1/cb']), 'native');
  // Whole 127.0.0.0/8 range plus 0.0.0.0 count as loopback.
  assert.equal(inferApplicationType(['http://127.0.0.2/cb']), 'native');
  assert.equal(inferApplicationType(['http://0.0.0.0:5000/cb']), 'native');
  assert.equal(inferApplicationType(['cursor://callback']), 'native');
  assert.equal(inferApplicationType(['vscode://ms/auth', 'http://localhost/cb']), 'native');
});

test('inferApplicationType: a set of purely remote origins is web', () => {
  assert.equal(inferApplicationType(['https://app.example.com/cb']), 'web');
});

test('inferApplicationType: any native redirect makes the whole client native', () => {
  // Looser than exact spec text, but avoids ever storing web + a native
  // redirect (a `web` client must use only https web URIs).
  assert.equal(inferApplicationType(['http://localhost/cb', 'https://app.example.com/cb']), 'native');
  assert.equal(inferApplicationType(['cursor://cb', 'https://app.example.com/cb']), 'native');
});

test('inferApplicationType: no redirects is not native', () => {
  assert.equal(inferApplicationType([]), 'web');
});

test('isRedirectUriAllowed: loopback matches ignore the port (RFC 8252)', async () => {
  const clientId = await createStatelessClientId({
    redirect_uris: ['http://127.0.0.1:1234/callback'],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
  });
  const { client } = await resolveClient(clientId);
  assert.ok(client);

  // Different ephemeral port on the same loopback host+path: allowed.
  assert.equal(isRedirectUriAllowed(client, 'http://127.0.0.1:56789/callback'), true);
  assert.equal(isRedirectUriAllowed(client, 'http://127.0.0.1/callback'), true);
  // Different path is still rejected.
  assert.equal(isRedirectUriAllowed(client, 'http://127.0.0.1:1234/evil'), false);
  // A remote host is never treated as loopback.
  assert.equal(isRedirectUriAllowed(client, 'http://evil.com:1234/callback'), false);
  // Port is the ONLY thing ignored: injected userinfo / query / fragment must
  // not slip past the match (they'd otherwise ride into the Location header).
  assert.equal(isRedirectUriAllowed(client, 'http://evil@127.0.0.1:9999/callback'), false);
  assert.equal(isRedirectUriAllowed(client, 'http://127.0.0.1:9999/callback?next=//attacker'), false);
  assert.equal(isRedirectUriAllowed(client, 'http://127.0.0.1:9999/callback#x'), false);
});

test('stateless client_id round-trips through resolveClient', async () => {
  const redirectUris = ['https://client.example.com/callback'];
  const clientId = await createStatelessClientId({
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    scope: 'read write',
  });

  const { client, source } = await resolveClient(clientId);
  assert.equal(source, 'stateless');
  assert.ok(client);
  assert.deepEqual(client.redirect_uris, redirectUris);
  assert.equal(client.token_endpoint_auth_method, 'none');
  assert.equal(client.scope, 'read write');
  assert.equal(client.client_id, clientId);
});

test('isRedirectUriAllowed is an exact string match (no prefix/substring)', async () => {
  const clientId = await createStatelessClientId({
    redirect_uris: ['https://client.example.com/callback'],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
  });
  const { client } = await resolveClient(clientId);
  assert.ok(client);

  assert.equal(isRedirectUriAllowed(client, 'https://client.example.com/callback'), true);
  // Attacker variations that a naive prefix/substring check would wrongly allow.
  assert.equal(isRedirectUriAllowed(client, 'https://client.example.com/callback/../evil'), false);
  assert.equal(isRedirectUriAllowed(client, 'https://client.example.com.evil.com/callback'), false);
  assert.equal(isRedirectUriAllowed(client, 'https://client.example.com/callback?x=1'), false);
});

test('resolveClient returns unknown for a legacy opaque client_id', async () => {
  const { client, source } = await resolveClient('legacy-opaque-random-id-1234567890');
  assert.equal(client, null);
  assert.equal(source, 'unknown');
});

test('resolveClient returns unknown for empty/missing ids', async () => {
  assert.equal((await resolveClient(undefined)).source, 'unknown');
  assert.equal((await resolveClient('')).source, 'unknown');
});

test('resolveClient recognizes a pre-provisioned static client', async () => {
  const staticId = staticClients[0].client_id;
  const { client, source } = await resolveClient(staticId);
  assert.equal(source, 'static');
  assert.ok(client);
  assert.equal(client.client_id, staticId);
  assert.deepEqual(client.redirect_uris, staticClients[0].redirect_uris);
});
