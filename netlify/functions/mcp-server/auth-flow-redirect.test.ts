import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import {
  handleAuthStart,
  handleClientRegistration,
  handleCodeExchange,
  handleServerSideAuthRedirect,
} from './auth-flow.ts';
import { staticClients } from './oauth-clients.ts';
import { SUPPORTED_SCOPES } from './oauth-config.ts';

// Pin the dev-key path regardless of ambient env: a localhost issuer with no
// JWE_SECRET makes createJWE/decryptJWE use the fixed dev-only key.
process.env.OAUTH_ISSUER = 'http://localhost:8888';
delete process.env.JWE_SECRET;

const ISSUER = 'http://localhost:8888';
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

function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function register(redirectUris: string[]): Promise<string> {
  const res = await handleClientRegistration(
    new Request(`${ISSUER}/oauth-server/reg`, {
      method: 'POST',
      body: JSON.stringify({ redirect_uris: redirectUris, client_name: 'Redirect binding test' }),
    }),
    SUPPORTED_SCOPES,
  );
  assert.equal(res.statusCode, 201);
  return JSON.parse(res.body as string).client_id;
}

function authorize(clientId: string, redirectUri: string, challenge: string, scope?: string) {
  const url = new URL(`${ISSUER}/oauth-server/auth`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', 'client-state');
  if (scope) url.searchParams.set('scope', scope);
  return handleAuthStart(new Request(url));
}

// The init-state the browser hands back to server-redirect is a base64 JSON
// blob the attacker can author directly, so build it the way they would.
function initState(fields: Record<string, string>): string {
  return Buffer.from(JSON.stringify({
    response_type: 'code',
    code_challenge_method: 'S256',
    ...fields,
  })).toString('base64');
}

// What the client-redirect page posts, from the browser holding `cookie`.
function serverRedirect(state: string, cookie?: string) {
  return handleServerSideAuthRedirect(new Request(`${ISSUER}/oauth-server/server-redirect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams({ token: 'netlify-token-from-browser', 'init-state': state }).toString(),
  }));
}

// The consent page's Continue link, which carries the sealed state to Netlify.
function continueUrl(res: { body?: string }): URL {
  const href = res.body?.match(/id="continue" href="([^"]+)"/)?.[1];
  assert.ok(href, 'expected a Continue link on the consent page');
  return new URL(href.replace(/&#38;/g, '&'));
}

// The cookie the consent page set, as the browser sends it back.
function browserCookie(res: { headers?: Record<string, unknown> }): string {
  const value = res.headers?.['Set-Cookie'];
  assert.equal(typeof value, 'string', 'expected the consent page to set a cookie');
  return (value as string).split(';')[0];
}

function exchange(form: Record<string, string>) {
  return handleCodeExchange(
    new Request(`${ISSUER}/oauth-server/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    }),
  );
}

function location(res: { headers?: Record<string, unknown> }): URL {
  const value = res.headers?.Location;
  assert.equal(typeof value, 'string', 'expected a Location header');
  return new URL(value as string);
}

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

test('server-redirect: a tampered init-state cannot send the code to an unregistered redirect_uri', async () => {
  // SEC-691 / SEC-790: the attacker never calls /auth. They hand the victim an
  // app.netlify.com/authorize link whose state names a real client_id but
  // their own redirect_uri, and the code must not follow it. The state is no
  // longer something anyone but this server can author.
  const clientId = await register([REGISTERED_REDIRECT]);
  const res = await serverRedirect(initState({
    client_id: clientId,
    redirect_uri: ATTACKER_REDIRECT,
    code_challenge: pkcePair().challenge,
  }));
  assertRejectedWithoutRedirect(res, 'invalid_request');
});

test('server-redirect: an unresolvable client_id in init-state is rejected', async () => {
  const res = await serverRedirect(initState({
    client_id: 'legacy-opaque-random-id-1234567890',
    redirect_uri: ATTACKER_REDIRECT,
    code_challenge: pkcePair().challenge,
  }));
  assertRejectedWithoutRedirect(res, 'invalid_request');
});

test('the registered redirect_uri still completes the whole flow and binds the code to it', async () => {
  const clientId = await register([REGISTERED_REDIRECT]);
  const { verifier, challenge } = pkcePair();

  const start = await authorize(clientId, REGISTERED_REDIRECT, challenge);
  assert.equal(start.statusCode, 200);
  const netlifyAuthorize = continueUrl(start);
  assert.equal(netlifyAuthorize.origin, 'https://app.netlify.com');
  const state = netlifyAuthorize.searchParams.get('state');
  assert.ok(state);

  const redirect = await serverRedirect(state, browserCookie(start));
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
  assert.equal(res.statusCode, 200);
  // Still exact on everything but the port.
  const other = await authorize(clientId, 'http://127.0.0.1:50321/other', pkcePair().challenge);
  assertRejectedWithoutRedirect(other, 'invalid_request');
});

test('authorize: every pre-provisioned static client is bound to its registered redirects too', async () => {
  for (const client of staticClients) {
    const ok = await authorize(client.client_id, client.redirect_uris[0], pkcePair().challenge);
    assert.equal(ok.statusCode, 200, `${client.client_id} with its own redirect`);
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
  const ok = await authorize(CHATGPT_ID, CHATGPT_REDIRECT, challenge, 'offline_access');
  assert.equal(ok.statusCode, 200);
  const elsewhere = await authorize(CHATGPT_ID, 'https://chatgpt.com.attacker.example/connector_platform_oauth_redirect', pkcePair().challenge);
  assertRejectedWithoutRedirect(elsewhere, 'invalid_request');

  // The whole flow, as the connector drives it: code to its redirect, then
  // exchange and refresh with the pinned id.
  const redirect = await serverRedirect(continueUrl(ok).searchParams.get('state')!, browserCookie(ok));
  assert.equal(redirect.statusCode, 302);
  const callback = location(redirect);
  assert.equal(`${callback.origin}${callback.pathname}`, CHATGPT_REDIRECT);
  const token = await exchange({ grant_type: 'authorization_code', code: callback.searchParams.get('code')!, client_id: CHATGPT_ID, redirect_uri: CHATGPT_REDIRECT, code_verifier: verifier });
  assert.equal(token.statusCode, 200);
  const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: JSON.parse(token.body as string).refresh_token, client_id: CHATGPT_ID });
  assert.equal(refreshed.statusCode, 200);
  assert.equal(JSON.parse(refreshed.body as string).token_type, 'Bearer');
});
