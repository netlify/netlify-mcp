import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { staticClients } from './oauth-clients.ts';
import {
  approve,
  authorize,
  callback,
  completeFlow,
  exchange,
  finish,
  location,
  pkcePair,
  register,
  startFlow,
} from './oauth-test-flow.ts';

// Pin the dev-key path regardless of ambient env: a localhost issuer with no
// JWE_SECRET makes createJWE/decryptJWE use the fixed dev-only key, and the
// in-memory grant store stands in for Netlify Blobs.
process.env.OAUTH_ISSUER = 'http://localhost:8888';
process.env.OAUTH_STORE = 'memory';
delete process.env.JWE_SECRET;

const REGISTERED_REDIRECT = 'https://client.example.com/callback';
const ATTACKER_REDIRECT = 'https://attacker.example.net/callback';

// Rejections log at error level and the happy path at info; silence both so the
// test output stays readable. Restored in after().
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
// server-redirect resolves the user's identity from the Netlify API before it
// issues a code. That lookup is best-effort and off-topic here, so answer it
// locally instead of letting the test reach the network.
const origFetch = globalThis.fetch;
before(() => {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  globalThis.fetch = async () => new Response('{}', { status: 401 });
});
after(() => {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;
  globalThis.fetch = origFetch;
});

function assertRejectedWithoutRedirect(res: any, error: string) {
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers?.Location, undefined, 'a rejected redirect_uri must never be redirected to');
  assert.equal(JSON.parse(res.body).error, error);
}

test('authorize: a redirect_uri the client did not register is rejected, not forwarded', async () => {
  const clientId = await register([REGISTERED_REDIRECT]);
  const res = await authorize(clientId, ATTACKER_REDIRECT, pkcePair().challenge);
  assertRejectedWithoutRedirect(res, 'invalid_request');
});

test('authorize: a client_id this server cannot resolve is rejected', async () => {
  const res = await authorize('legacy-opaque-random-id-1234567890', REGISTERED_REDIRECT, pkcePair().challenge);
  assertRejectedWithoutRedirect(res, 'invalid_client');
});

test('server-redirect: a callback that never went through /auth cannot send a code anywhere', async () => {
  // SEC-691 / SEC-790: the attacker never calls /auth. They used to hand the
  // victim an app.netlify.com/authorize link whose state named a real
  // client_id but their own redirect_uri. State is now an opaque transaction
  // id resolved server-side, so a made-up one, with or without a cookie,
  // mints nothing.
  const forged = Buffer.from(JSON.stringify({ client_id: 'x', redirect_uri: ATTACKER_REDIRECT })).toString('base64');
  const res = await callback({ token: 'netlify-token-from-browser', state: forged }, null);
  assertRejectedWithoutRedirect(res, 'invalid_request');
  const random = await callback({ token: 'netlify-token-from-browser', state: 'A'.repeat(43) }, 'netlify_mcp_oauth=' + 'B'.repeat(43));
  assertRejectedWithoutRedirect(random, 'invalid_request');
});

test('server-redirect: the Netlify token is only accepted in a POST body, never a query string', async () => {
  const res = await callback({}, null, 'GET');
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers?.Location, undefined);
});

test('the registered redirect_uri still completes the whole flow and binds the code to it', async () => {
  const clientId = await register([REGISTERED_REDIRECT]);
  const { verifier, challenge } = pkcePair();

  const flow = await startFlow(clientId, REGISTERED_REDIRECT, challenge);
  const netlifyAuthorize = await approve(flow);
  // The upstream state is the transaction id, not the client's request.
  assert.equal(netlifyAuthorize.searchParams.get('state'), flow.txn);

  const redirect = await finish(flow, netlifyAuthorize);
  assert.equal(redirect.statusCode, 302);
  const clientCallback = location(redirect);
  assert.equal(`${clientCallback.origin}${clientCallback.pathname}`, REGISTERED_REDIRECT);
  assert.equal(clientCallback.searchParams.get('state'), 'client-state');
  const code = clientCallback.searchParams.get('code');
  assert.ok(code);

  // The code is bound to the client, the redirect and the PKCE challenge.
  const wrongClient = await exchange({ grant_type: 'authorization_code', code, client_id: await register([ATTACKER_REDIRECT]), redirect_uri: REGISTERED_REDIRECT, code_verifier: verifier });
  assert.equal(wrongClient.statusCode, 400);
  assert.equal(JSON.parse(wrongClient.body as string).error, 'invalid_grant');
  const wrongRedirect = await exchange({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: ATTACKER_REDIRECT, code_verifier: verifier });
  assert.equal(wrongRedirect.statusCode, 400);
  assert.equal(JSON.parse(wrongRedirect.body as string).error, 'invalid_grant');
  const wrongVerifier = await exchange({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REGISTERED_REDIRECT, code_verifier: pkcePair().verifier });
  assert.equal(wrongVerifier.statusCode, 400);
  assert.equal(JSON.parse(wrongVerifier.body as string).error, 'invalid_grant');

  const token = await exchange({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REGISTERED_REDIRECT, code_verifier: verifier });
  assert.equal(token.statusCode, 200);
  assert.equal(JSON.parse(token.body as string).token_type, 'Bearer');
});

test('authorize: a native client may vary the loopback port (RFC 8252)', async () => {
  const clientId = await register(['http://127.0.0.1:1234/cb']);
  const res = await authorize(clientId, 'http://127.0.0.1:50321/cb', pkcePair().challenge);
  assert.equal(res.statusCode, 302);
  // Still exact on everything but the port.
  const other = await authorize(clientId, 'http://127.0.0.1:50321/other', pkcePair().challenge);
  assertRejectedWithoutRedirect(other, 'invalid_request');
});

test('authorize: every pre-provisioned static client is bound to its registered redirects too', async () => {
  for (const client of staticClients) {
    const ok = await authorize(client.client_id, client.redirect_uris[0], pkcePair().challenge);
    assert.equal(ok.statusCode, 302, `${client.client_id} with its own redirect`);
    const spoofed = await authorize(client.client_id, ATTACKER_REDIRECT, pkcePair().challenge);
    assertRejectedWithoutRedirect(spoofed, 'invalid_request');
  }
});

test('the legacy ChatGPT registration keeps working, on its own redirect only', async () => {
  // Registered through the pre-stateless dynamic registration and still
  // presented on roughly half of production logins (see oauth-clients.ts).
  // The id is the one production requests carry, so it is asserted literally.
  const CHATGPT_ID = '2m93QbON-vPRJMMIGA_MEzG1fkejj4JNAgb97ZC3gPd';
  const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const chatgpt = staticClients.find((c) => c.client_id === CHATGPT_ID);
  assert.ok(chatgpt);
  assert.deepEqual(chatgpt.redirect_uris, [CHATGPT_REDIRECT]);

  const { verifier, challenge } = pkcePair();
  const elsewhere = await authorize(CHATGPT_ID, 'https://chatgpt.com.attacker.example/connector_platform_oauth_redirect', pkcePair().challenge);
  assertRejectedWithoutRedirect(elsewhere, 'invalid_request');

  // The whole flow, as the connector drives it: code to its redirect, then
  // exchange and refresh with the pinned id.
  const flow = await completeFlow(CHATGPT_ID, CHATGPT_REDIRECT, challenge, 'offline_access');
  assert.match(flow.consentHtml, /Verified application/);
  assert.match(flow.consentHtml, /ChatGPT/);
  assert.equal(`${flow.clientCallback.origin}${flow.clientCallback.pathname}`, CHATGPT_REDIRECT);
  const token = await exchange({ grant_type: 'authorization_code', code: flow.code, client_id: CHATGPT_ID, redirect_uri: CHATGPT_REDIRECT, code_verifier: verifier });
  assert.equal(token.statusCode, 200);
  const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: JSON.parse(token.body as string).refresh_token, client_id: CHATGPT_ID });
  assert.equal(refreshed.statusCode, 200);
  assert.equal(JSON.parse(refreshed.body as string).token_type, 'Bearer');
});
