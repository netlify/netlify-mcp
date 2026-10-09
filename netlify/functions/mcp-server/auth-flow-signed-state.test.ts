import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.OAUTH_ISSUER = 'https://mcp.netlify.example.com';
process.env.NTL_AUTH_CLIENT_ID = 'test-ntl-client';
process.env.JWE_SECRET = 'b'.repeat(32);

const {
  handleAuthStart,
  handleClientRegistration,
  handleCodeExchange,
  handleServerSideAuthRedirect,
} = await import('./auth-flow.ts');
const { createJWE, decryptJWE } = await import('./utils.ts');
const { getNetlifyAccessToken, NetlifyUnauthError } = await import('../../../src/utils/api-networking.ts');
const { handleProxy } = await import('../../edge-functions/proxy.ts');

const ISSUER = 'https://mcp.netlify.example.com';
const CLIENT_REDIRECT = 'https://client.example.com/callback';
const ATTACKER_REDIRECT = 'https://attacker.example/callback';
const VERIFIER = 'verifier-'.padEnd(64, 'x');
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

// server-redirect looks up the user for log attribution; keep that offline.
const origFetch = globalThis.fetch;
const origWarn = console.warn;
const origError = console.error;
before(() => {
  globalThis.fetch = (async () => new Response('{}', { status: 401 })) as typeof fetch;
  console.warn = () => {};
  console.error = () => {};
});
after(() => {
  globalThis.fetch = origFetch;
  console.warn = origWarn;
  console.error = origError;
});

async function registerClient(redirectUri: string): Promise<string> {
  const res = await handleClientRegistration(new Request(`${ISSUER}/oauth-server/reg`, {
    method: 'POST',
    body: JSON.stringify({ client_name: 'Test client', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] }),
  }), ['offline_access']);
  return JSON.parse(res.body as string).client_id;
}

/** Runs /authorize and returns the state it hands to app.netlify.com. */
async function authorize(clientId: string, redirectUri: string): Promise<string> {
  const url = new URL(`${ISSUER}/oauth-server/auth`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'client-state',
    scope: 'offline_access',
  }).toString();
  const res = await handleAuthStart(new Request(url));
  assert.equal(res.statusCode, 302);
  const location = new URL(res.headers!.Location as string);
  assert.equal(location.origin, 'https://app.netlify.com');
  return location.searchParams.get('state') as string;
}

function serverRedirect(initState: string) {
  const url = new URL(`${ISSUER}/oauth-server/server-redirect`);
  url.searchParams.set('token', 'nfp_upstream_token');
  url.searchParams.set('init-state', initState);
  return handleServerSideAuthRedirect(new Request(url));
}

/** Reads a JWS payload the way Netlify's consent screen does: no key. */
function readPayload(jws: string): Record<string, any> {
  return JSON.parse(Buffer.from(jws.split('.')[1], 'base64url').toString('utf8'));
}

async function exchange(code: string, clientId: string, redirectUri = CLIENT_REDIRECT) {
  const res = await handleCodeExchange(new Request(`${ISSUER}/oauth-server/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, code_verifier: VERIFIER }),
  }));
  return { status: res.statusCode, json: JSON.parse(res.body as string) };
}

async function refresh(refreshToken: string) {
  const res = await handleCodeExchange(new Request(`${ISSUER}/oauth-server/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  }));
  return { status: res.statusCode, json: JSON.parse(res.body as string) };
}

async function signIn() {
  const clientId = await registerClient(CLIENT_REDIRECT);
  const initState = await authorize(clientId, CLIENT_REDIRECT);
  const res = await serverRedirect(initState);
  assert.equal(res.statusCode, 302);
  const code = new URL(res.headers!.Location as string).searchParams.get('code') as string;
  const tokens = await exchange(code, clientId);
  assert.equal(tokens.status, 200);
  return { clientId, code, accessToken: tokens.json.access_token, refreshToken: tokens.json.refresh_token };
}

const bearer = (token: string) => new Request(`${ISSUER}/mcp`, { headers: { Authorization: `Bearer ${token}` } });
const proxyCall = (token: string) => handleProxy(
  new Request(`${ISSUER}/proxy/${token}/api/v1/deploys/abc`, { method: 'GET' }),
  token,
);

test('authorize hands Netlify a signed state whose payload shows the redirect without a key', async () => {
  const clientId = await registerClient(CLIENT_REDIRECT);
  const initState = await authorize(clientId, CLIENT_REDIRECT);

  assert.equal(initState.split('.').length, 3, 'compact JWS');
  const payload = readPayload(initState);
  assert.equal(payload.v, 1);
  assert.equal(payload.redirect_uri, CLIENT_REDIRECT);
  assert.equal(new URL(payload.redirect_uri).origin, 'https://client.example.com');
});

test('server-redirect sends the code to the redirect in the signed state', async () => {
  const clientId = await registerClient(CLIENT_REDIRECT);
  const res = await serverRedirect(await authorize(clientId, CLIENT_REDIRECT));

  assert.equal(res.statusCode, 302);
  const location = new URL(res.headers!.Location as string);
  assert.equal(`${location.origin}${location.pathname}`, CLIENT_REDIRECT);
  assert.equal(location.searchParams.get('state'), 'client-state');
  assert.ok(location.searchParams.get('code'));
});

test('server-redirect refuses the old unsigned base64 state', async () => {
  // A state built by hand rather than issued by /authorize, naming a
  // registered client's redirect.
  const attackerClientId = await registerClient(ATTACKER_REDIRECT);
  const forged = Buffer.from(JSON.stringify({
    response_type: 'code',
    client_id: attackerClientId,
    redirect_uri: ATTACKER_REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  })).toString('base64');

  const res = await serverRedirect(forged);
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers!.Location, undefined);
});

test('server-redirect refuses a signed state whose redirect was swapped', async () => {
  const clientId = await registerClient(CLIENT_REDIRECT);
  const initState = await authorize(clientId, CLIENT_REDIRECT);
  const [header, , signature] = initState.split('.');
  const edited = Buffer.from(JSON.stringify({ ...readPayload(initState), redirect_uri: ATTACKER_REDIRECT })).toString('base64url');

  const res = await serverRedirect(`${header}.${edited}.${signature}`);
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers!.Location, undefined);
});

test('server-redirect refuses a state signed with a different key', async () => {
  const { SignJWT } = await import('jose');
  const clientId = await registerClient(CLIENT_REDIRECT);
  const payload = readPayload(await authorize(clientId, CLIENT_REDIRECT));
  const foreign = await new SignJWT({ ...payload, redirect_uri: ATTACKER_REDIRECT })
    .setProtectedHeader({ alg: 'HS256', typ: 'mcp-init-state+jwt' })
    .sign(new TextEncoder().encode('c'.repeat(32)));

  const res = await serverRedirect(foreign);
  assert.equal(res.statusCode, 400);
});

test('issued tokens are typed', async () => {
  const { code, accessToken, refreshToken } = await signIn();
  assert.equal((await decryptJWE(code)).typ, 'code');
  assert.equal((await decryptJWE(accessToken)).typ, 'access');
  const refreshPayload = await decryptJWE(refreshToken);
  assert.equal(refreshPayload.typ, 'refresh');
  assert.equal(refreshPayload.type, 'refresh', 'legacy marker kept for rollback');
});

test('/mcp accepts an access token but not a code, refresh or proxy token', async () => {
  const { code, accessToken, refreshToken } = await signIn();
  const proxyToken = await createJWE({ typ: 'proxy', accessToken: 'nfp_upstream_token', apisAllowed: [] });

  assert.equal(await getNetlifyAccessToken(bearer(accessToken)), 'nfp_upstream_token');
  for (const token of [code, refreshToken, proxyToken]) {
    await assert.rejects(getNetlifyAccessToken(bearer(token)), NetlifyUnauthError);
  }
});

test('/proxy accepts a proxy token but not an access token', async () => {
  const { accessToken } = await signIn();
  const proxyToken = await createJWE({
    typ: 'proxy',
    accessToken: 'nfp_upstream_token',
    apisAllowed: [{ path: '/api/v1/deploys/:deploy_id', method: 'GET' }],
  });

  globalThis.fetch = (async () => new Response('ok')) as typeof fetch;
  try {
    assert.equal((await proxyCall(proxyToken)).status, 200);
    assert.equal((await proxyCall(accessToken)).status, 401);
  } finally {
    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as typeof fetch;
  }
});

test('/token takes codes and refresh tokens only where each belongs', async () => {
  const { clientId, code, accessToken, refreshToken } = await signIn();

  assert.equal((await exchange(accessToken, clientId)).status, 400, 'access token as code');
  assert.equal((await exchange(refreshToken, clientId)).status, 400, 'refresh token as code');
  assert.equal((await refresh(code)).status, 400, 'code as refresh token');
  assert.equal((await refresh(accessToken)).status, 400, 'access token as refresh token');

  const refreshed = await refresh(refreshToken);
  assert.equal(refreshed.status, 200);
  assert.equal((await decryptJWE(refreshed.json.access_token)).typ, 'access');
  assert.equal((await decryptJWE(refreshed.json.refresh_token)).typ, 'refresh');
});

test('untyped tokens from before this change keep working where they did', async () => {
  const legacyAccess = await createJWE({ accessToken: 'nfp_legacy' }, '48h');
  const legacyRefresh = await createJWE({ accessToken: 'nfp_legacy', type: 'refresh' }, '7d');
  const legacyProxy = await createJWE({ accessToken: 'nfp_legacy', apisAllowed: [{ path: '/api/v1/deploys/:deploy_id', method: 'GET' }] }, '30m');

  assert.equal(await getNetlifyAccessToken(bearer(legacyAccess)), 'nfp_legacy');

  const refreshed = await refresh(legacyRefresh);
  assert.equal(refreshed.status, 200);
  assert.equal((await decryptJWE(refreshed.json.access_token)).typ, 'access', 'refresh upgrades to typed tokens');

  globalThis.fetch = (async () => new Response('ok')) as typeof fetch;
  try {
    assert.equal((await proxyCall(legacyProxy)).status, 200);
  } finally {
    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as typeof fetch;
  }
});
