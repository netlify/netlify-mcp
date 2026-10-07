import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import {
  handleAuthStart,
  handleClientRegistration,
  handleClientSideAuthExchange,
  handleCodeExchange,
  handleServerSideAuthRedirect,
} from './auth-flow.ts';
import { SUPPORTED_SCOPES } from './oauth-config.ts';
import { createJWE } from './utils.ts';
import { getNetlifyAccessToken, NetlifyUnauthError } from '../../../src/utils/api-networking.ts';
import { handleProxy } from '../../edge-functions/proxy.ts';

// SEC-790: a link to /auth with an attacker-registered client sent a person's
// Netlify token to the attacker, and every token this server seals opened /mcp.

process.env.OAUTH_ISSUER = 'http://localhost:8888';
delete process.env.JWE_SECRET;

const ISSUER = 'http://localhost:8888';
const VICTIM_CLIENT_REDIRECT = 'https://client.example.com/callback';
const ATTACKER_REDIRECT = 'https://attacker.example.net/callback';
const NETLIFY_TOKEN = 'nfo_netlify_token_from_browser';

const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
const origFetch = globalThis.fetch;
let upstreamCalls = 0;
before(() => {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  globalThis.fetch = async () => {
    upstreamCalls++;
    return new Response('{}', { status: 401 });
  };
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

async function register(redirectUris: string[], clientName = 'Test client'): Promise<string> {
  const res = await handleClientRegistration(
    new Request(`${ISSUER}/oauth-server/reg`, {
      method: 'POST',
      body: JSON.stringify({ redirect_uris: redirectUris, client_name: clientName }),
    }),
    SUPPORTED_SCOPES,
  );
  assert.equal(res.statusCode, 201);
  return JSON.parse(res.body as string).client_id;
}

function authorize(clientId: string, redirectUri: string, challenge: string, extra: Record<string, string> = {}) {
  const url = new URL(`${ISSUER}/oauth-server/auth`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', 'client-state');
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return handleAuthStart(new Request(url));
}

function link(html: string, id: string): URL {
  const href = html.match(new RegExp(`id="${id}" href="([^"]+)"`))?.[1];
  assert.ok(href, `expected a ${id} link on the consent page`);
  return new URL(href.replace(/&#38;/g, '&'));
}

function cookieOf(res: { headers?: Record<string, unknown> }): string {
  return String(res.headers?.['Set-Cookie']).split(';')[0];
}

function serverRedirect(state: string, cookie?: string) {
  return handleServerSideAuthRedirect(new Request(`${ISSUER}/oauth-server/server-redirect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams({ token: NETLIFY_TOKEN, 'init-state': state }).toString(),
  }));
}

function exchange(form: Record<string, string>) {
  return handleCodeExchange(new Request(`${ISSUER}/oauth-server/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  }));
}

function bearer(token: string): Request {
  return new Request(`${ISSUER}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
}

async function assertNotAnAccessToken(token: string) {
  await assert.rejects(getNetlifyAccessToken(bearer(token)), NetlifyUnauthError);
}

// One complete, legitimate sign-in: the tokens a real client ends up with.
async function signIn() {
  const clientId = await register([VICTIM_CLIENT_REDIRECT]);
  const { verifier, challenge } = pkcePair();
  const start = await authorize(clientId, VICTIM_CLIENT_REDIRECT, challenge, { scope: 'offline_access' });
  const redirect = await serverRedirect(link(start.body as string, 'continue').searchParams.get('state')!, cookieOf(start));
  assert.equal(redirect.statusCode, 302);
  const code = new URL(String(redirect.headers?.Location)).searchParams.get('code')!;
  const token = await exchange({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: VICTIM_CLIENT_REDIRECT, code_verifier: verifier });
  assert.equal(token.statusCode, 200);
  const { access_token, refresh_token } = JSON.parse(token.body as string);
  return { clientId, code, access_token, refresh_token };
}

test('authorize shows a consent page naming where access will be sent, instead of redirecting', async () => {
  const clientId = await register([ATTACKER_REDIRECT], '<img src=x onerror=alert(1)>Claude');
  const res = await authorize(clientId, ATTACKER_REDIRECT, pkcePair().challenge);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers?.Location, undefined);
  const html = res.body as string;
  assert.ok(html.includes('attacker.example.net'), 'the redirect host is shown');
  assert.ok(!html.includes('<img src=x'), 'the registered name is escaped');
  assert.ok(html.includes('&#60;img src=x onerror=alert(1)&#62;Claude'));
  assert.equal(link(html, 'continue').origin, 'https://app.netlify.com');

  const csp = String(res.headers?.['Content-Security-Policy']);
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.equal(res.headers?.['X-Frame-Options'], 'DENY');

  const cookie = String(res.headers?.['Set-Cookie']);
  assert.match(cookie, /^__Host-mcp-oauth-txn=[\w-]{43}; /);
  for (const attr of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax']) {
    assert.ok(cookie.includes(attr), `cookie has ${attr}`);
  }
});

test('cancel on the consent page returns access_denied to the registered redirect', async () => {
  const clientId = await register([VICTIM_CLIENT_REDIRECT]);
  const res = await authorize(clientId, VICTIM_CLIENT_REDIRECT, pkcePair().challenge);
  const cancel = link(res.body as string, 'cancel');
  assert.equal(`${cancel.origin}${cancel.pathname}`, VICTIM_CLIENT_REDIRECT);
  assert.equal(cancel.searchParams.get('error'), 'access_denied');
  assert.equal(cancel.searchParams.get('state'), 'client-state');
});

test("the attacker's own authorization cannot be completed in the victim's browser", async () => {
  // The attacker visits /auth for a client they registered, keeps the sealed
  // state from the Continue link, and sends the victim straight to
  // app.netlify.com with it, skipping the consent page.
  const attackerClient = await register([ATTACKER_REDIRECT]);
  const attackerStart = await authorize(attackerClient, ATTACKER_REDIRECT, pkcePair().challenge);
  const attackerState = link(attackerStart.body as string, 'continue').searchParams.get('state')!;

  // The victim's browser has no transaction cookie...
  const noCookie = await serverRedirect(attackerState);
  assert.equal(noCookie.statusCode, 400);
  assert.equal(noCookie.headers?.Location, undefined);

  // ...or one from a sign-in of their own, which binds to a different state.
  const victimClient = await register([VICTIM_CLIENT_REDIRECT]);
  const victimStart = await authorize(victimClient, VICTIM_CLIENT_REDIRECT, pkcePair().challenge);
  const otherBrowser = await serverRedirect(attackerState, cookieOf(victimStart));
  assert.equal(otherBrowser.statusCode, 400);
  assert.equal(otherBrowser.headers?.Location, undefined);

  // In the attacker's own browser it completes, to their own account only.
  const ownBrowser = await serverRedirect(attackerState, cookieOf(attackerStart));
  assert.equal(ownBrowser.statusCode, 302);
});

test('a client nonce parameter does not replace the browser binding', async () => {
  const clientId = await register([VICTIM_CLIENT_REDIRECT]);
  const start = await authorize(clientId, VICTIM_CLIENT_REDIRECT, pkcePair().challenge, { nonce: 'client-chosen' });
  const res = await serverRedirect(link(start.body as string, 'continue').searchParams.get('state')!, `__Host-mcp-oauth-txn=client-chosen`);
  assert.equal(res.statusCode, 400);
  const ok = await serverRedirect(link(start.body as string, 'continue').searchParams.get('state')!, cookieOf(start));
  assert.equal(ok.statusCode, 302);
});

test('a successful hand-off clears the transaction cookie', async () => {
  const clientId = await register([VICTIM_CLIENT_REDIRECT]);
  const start = await authorize(clientId, VICTIM_CLIENT_REDIRECT, pkcePair().challenge);
  const res = await serverRedirect(link(start.body as string, 'continue').searchParams.get('state')!, cookieOf(start));
  assert.equal(res.statusCode, 302);
  assert.match(String(res.headers?.['Set-Cookie']), /^__Host-mcp-oauth-txn=; .*Max-Age=0/);
});

test('server-redirect refuses a Netlify token in the query string', async () => {
  const url = new URL(`${ISSUER}/oauth-server/server-redirect`);
  url.searchParams.set('token', NETLIFY_TOKEN);
  url.searchParams.set('init-state', 'anything');
  const res = await handleServerSideAuthRedirect(new Request(url));
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers?.Location, undefined);
});

test('the client-redirect page posts the token instead of putting it in a URL', async () => {
  const res = await handleClientSideAuthExchange();
  const html = res.body as string;
  assert.ok(html.includes("form.method = 'POST'"));
  assert.ok(!html.includes('server-redirect?token='));
});

test('/mcp accepts only access tokens: not codes, refresh tokens or proxy tokens', async () => {
  const { code, access_token, refresh_token } = await signIn();
  assert.equal(await getNetlifyAccessToken(bearer(access_token)), NETLIFY_TOKEN);

  await assertNotAnAccessToken(code);
  await assertNotAnAccessToken(refresh_token);
  await assertNotAnAccessToken(await createJWE({ token_use: 'proxy', accessToken: NETLIFY_TOKEN, apisAllowed: [] }, '30m'));
  // The untyped shape every token had before token_use: no longer accepted.
  await assertNotAnAccessToken(await createJWE({ accessToken: NETLIFY_TOKEN }, '48h'));
  await assertNotAnAccessToken(await createJWE({ accessToken: NETLIFY_TOKEN, state: { client_id: 'x' } }, '1h'));
});

test('the token endpoint accepts each token only for its own grant', async () => {
  const { clientId, access_token, refresh_token } = await signIn();
  const { verifier } = pkcePair();

  const accessAsCode = await exchange({ grant_type: 'authorization_code', code: access_token, client_id: clientId, redirect_uri: VICTIM_CLIENT_REDIRECT, code_verifier: verifier });
  assert.equal(accessAsCode.statusCode, 400);
  assert.equal(JSON.parse(accessAsCode.body as string).error, 'invalid_grant');

  const accessAsRefresh = await exchange({ grant_type: 'refresh_token', refresh_token: access_token });
  assert.equal(accessAsRefresh.statusCode, 400);

  const legacyRefresh = await exchange({ grant_type: 'refresh_token', refresh_token: await createJWE({ accessToken: NETLIFY_TOKEN, type: 'refresh' }, '7d') });
  assert.equal(legacyRefresh.statusCode, 400);

  const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token });
  assert.equal(refreshed.statusCode, 200);
  assert.equal(await getNetlifyAccessToken(bearer(JSON.parse(refreshed.body as string).access_token)), NETLIFY_TOKEN);
});

test('/proxy accepts only proxy tokens, and never forwards without an allow-list', async () => {
  const { access_token, code } = await signIn();
  const path = '/api/v1/sites/abc/builds';
  const before = upstreamCalls;
  for (const token of [
    access_token,
    code,
    await createJWE({ accessToken: NETLIFY_TOKEN, apisAllowed: [{ path, method: 'POST' }] }, '30m'),
    await createJWE({ token_use: 'proxy', accessToken: NETLIFY_TOKEN }, '30m'),
  ]) {
    const res = await handleProxy(new Request(`https://mcp.example/proxy/${token}${path}`, { method: 'POST' }), token);
    assert.equal(res.status, 401);
  }
  assert.equal(upstreamCalls, before, 'nothing reached the Netlify API');

  const proxyToken = await createJWE({ token_use: 'proxy', accessToken: NETLIFY_TOKEN, apisAllowed: [{ path, method: 'POST' }] }, '30m');
  await handleProxy(new Request(`https://mcp.example/proxy/${proxyToken}${path}`, { method: 'POST' }), proxyToken);
  assert.equal(upstreamCalls, before + 1, 'the proxy token is forwarded');
});
