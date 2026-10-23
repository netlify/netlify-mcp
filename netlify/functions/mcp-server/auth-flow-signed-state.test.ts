import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.OAUTH_ISSUER = 'https://mcp.netlify.example.com';
process.env.NTL_AUTH_CLIENT_ID = 'test-ntl-client';
process.env.NTL_AUTH_CLIENT_SECRET = 'test-ntl-secret';
process.env.JWE_SECRET = 'b'.repeat(32);

const {
  handleAuthStart,
  handleClientRegistration,
  handleCodeExchange,
  handleNetlifyCallback,
} = await import('./auth-flow.ts');
const { createJWE, decryptJWE } = await import('./utils.ts');
const { getNetlifyAccessToken, NetlifyUnauthError } = await import('../../../src/utils/api-networking.ts');
const { handleProxy } = await import('../../edge-functions/proxy.ts');

const ISSUER = 'https://mcp.netlify.example.com';
const NETLIFY_CALLBACK = `${ISSUER}/oauth-server/client-redirect`;
const NETLIFY_TOKEN_URL = 'https://api.netlify.com/oauth/token';
const NETLIFY_CODE = 'netlify-one-time-code';
const UPSTREAM_TOKEN = 'nfp_upstream_token';
const CLIENT_SECRET = 'test-ntl-secret';
const CLIENT_REDIRECT = 'https://client.example.com/callback';
const ATTACKER_REDIRECT = 'https://attacker.example/callback';
const VERIFIER = 'verifier-'.padEnd(64, 'x');
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

// Anything a test doesn't stub (the identity lookup included) stays offline.
const offlineFetch = (async () => new Response('{}', { status: 401 })) as typeof fetch;
const origFetch = globalThis.fetch;
const origWarn = console.warn;
const origError = console.error;
before(() => {
  globalThis.fetch = offlineFetch;
  console.warn = () => {};
  console.error = () => {};
});
afterEach(() => {
  globalThis.fetch = offlineFetch;
});
after(() => {
  globalThis.fetch = origFetch;
  console.warn = origWarn;
  console.error = origError;
});

interface FetchCall { url: string; init?: RequestInit }

/**
 * Stands in for Netlify for one test: the token endpoint answers with
 * `tokenResponse`, the identity lookup with a user, and every call is recorded.
 */
function stubNetlify(tokenResponse = () => Response.json({ access_token: UPSTREAM_TOKEN, token_type: 'Bearer' })) {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    if (url === NETLIFY_TOKEN_URL) return tokenResponse();
    if (url === 'https://api.netlify.com/api/v1/user') return Response.json({ id: 'user-1', account_id: 'team-1' });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return {
    calls,
    tokenCalls: () => calls.filter((call) => call.url === NETLIFY_TOKEN_URL),
  };
}

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

function callback(params: Record<string, string>) {
  const url = new URL(NETLIFY_CALLBACK);
  url.search = new URLSearchParams(params).toString();
  return handleNetlifyCallback(new Request(url));
}

const errorOf = (res: { body?: string }) => JSON.parse(res.body as string).error;

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
  stubNetlify();
  const clientId = await registerClient(CLIENT_REDIRECT);
  const initState = await authorize(clientId, CLIENT_REDIRECT);
  const res = await callback({ code: NETLIFY_CODE, state: initState });
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

test('authorize asks Netlify for a code and returns to client-redirect', async () => {
  const clientId = await registerClient(CLIENT_REDIRECT);
  const url = new URL(`${ISSUER}/oauth-server/auth`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'client-state',
    scope: 'offline_access',
  }).toString();
  const res = await handleAuthStart(new Request(url));

  assert.equal(res.statusCode, 302);
  const location = new URL(res.headers!.Location as string);
  assert.equal(location.origin, 'https://app.netlify.com');
  assert.equal(location.searchParams.get('response_type'), 'code');
  assert.equal(location.searchParams.get('redirect_uri'), `${ISSUER}/oauth-server/client-redirect`);
  assert.ok((res.headers!.Location as string).includes(`redirect_uri=${encodeURIComponent(`${ISSUER}/oauth-server/client-redirect`)}&`), 'redirect_uri is percent-encoded');
});

test('callback exchanges the Netlify code on the server and sends an MCP code to the signed redirect', async () => {
  const netlify = stubNetlify();
  const clientId = await registerClient(CLIENT_REDIRECT);
  const res = await callback({ code: NETLIFY_CODE, state: await authorize(clientId, CLIENT_REDIRECT) });

  assert.equal(netlify.tokenCalls().length, 1);
  const [{ init }] = netlify.tokenCalls();
  assert.equal(init?.method, 'POST');
  assert.equal(new Headers(init?.headers).get('content-type'), 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(init?.body))), {
    grant_type: 'authorization_code',
    code: NETLIFY_CODE,
    redirect_uri: NETLIFY_CALLBACK,
    client_id: 'test-ntl-client',
    client_secret: CLIENT_SECRET,
  });

  assert.equal(res.statusCode, 302);
  const location = new URL(res.headers!.Location as string);
  assert.equal(`${location.origin}${location.pathname}`, CLIENT_REDIRECT);
  assert.equal(location.searchParams.get('state'), 'client-state');
  assert.equal(location.searchParams.get('iss'), `${ISSUER}/`);
  const code = location.searchParams.get('code') as string;
  assert.equal((await decryptJWE(code)).accessToken, UPSTREAM_TOKEN, 'the MCP code wraps the exchanged token');

  const response = JSON.stringify(res);
  for (const secret of [UPSTREAM_TOKEN, NETLIFY_CODE, CLIENT_SECRET]) {
    assert.ok(!response.includes(secret), `${secret} must not appear in the response`);
  }
});

test('callback refuses the old unsigned base64 state without calling Netlify', async () => {
  // A state built by hand rather than issued by /authorize, naming a
  // registered client's redirect.
  const netlify = stubNetlify();
  const attackerClientId = await registerClient(ATTACKER_REDIRECT);
  const forged = Buffer.from(JSON.stringify({
    response_type: 'code',
    client_id: attackerClientId,
    redirect_uri: ATTACKER_REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  })).toString('base64');

  const res = await callback({ code: NETLIFY_CODE, state: forged });
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers!.Location, undefined);
  assert.equal(netlify.calls.length, 0);
});

test('callback refuses a signed state whose redirect was swapped without calling Netlify', async () => {
  const netlify = stubNetlify();
  const clientId = await registerClient(CLIENT_REDIRECT);
  const initState = await authorize(clientId, CLIENT_REDIRECT);
  const [header, , signature] = initState.split('.');
  const edited = Buffer.from(JSON.stringify({ ...readPayload(initState), redirect_uri: ATTACKER_REDIRECT })).toString('base64url');

  const res = await callback({ code: NETLIFY_CODE, state: `${header}.${edited}.${signature}` });
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers!.Location, undefined);
  assert.equal(netlify.calls.length, 0);
});

test('callback refuses a state signed with a different key without calling Netlify', async () => {
  const { SignJWT } = await import('jose');
  const netlify = stubNetlify();
  const clientId = await registerClient(CLIENT_REDIRECT);
  const payload = readPayload(await authorize(clientId, CLIENT_REDIRECT));
  const foreign = await new SignJWT({ ...payload, redirect_uri: ATTACKER_REDIRECT })
    .setProtectedHeader({ alg: 'HS256', typ: 'mcp-init-state+jwt' })
    .sign(new TextEncoder().encode('c'.repeat(32)));

  const res = await callback({ code: NETLIFY_CODE, state: foreign });
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers!.Location, undefined);
  assert.equal(netlify.calls.length, 0);
});

test('callback refuses an expired state without calling Netlify', async (t) => {
  const netlify = stubNetlify();
  const clientId = await registerClient(CLIENT_REDIRECT);
  const initState = await authorize(clientId, CLIENT_REDIRECT);

  // Past the state's 30-minute lifetime.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 31 * 60 * 1000 });
  const res = await callback({ code: NETLIFY_CODE, state: initState });

  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body as string).error_description, 'Invalid or expired init-state parameter');
  assert.equal(res.headers!.Location, undefined);
  assert.equal(netlify.calls.length, 0);
});

test('callback refuses a code Netlify rejects and sends nothing to the client', async () => {
  const netlify = stubNetlify(() => Response.json({ error: 'invalid_grant' }, { status: 400 }));
  const clientId = await registerClient(CLIENT_REDIRECT);
  const res = await callback({ code: NETLIFY_CODE, state: await authorize(clientId, CLIENT_REDIRECT) });

  assert.equal(netlify.tokenCalls().length, 1);
  assert.equal(res.statusCode, 400);
  assert.equal(errorOf(res), 'invalid_grant');
  assert.equal(res.headers!.Location, undefined);
});

test('callback reports rejected client credentials as a server error and logs Netlify\'s error code', async () => {
  const netlify = stubNetlify(() => Response.json({ error: 'invalid_client', error_description: 'ECHOED-DESCRIPTION' }, { status: 401 }));
  const clientId = await registerClient(CLIENT_REDIRECT);
  const state = await authorize(clientId, CLIENT_REDIRECT);

  const lines: string[] = [];
  const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  const consoleBefore = { log: console.log, warn: console.warn, error: console.error };
  Object.assign(console, { log: capture, warn: capture, error: capture });
  let res;
  try {
    res = await callback({ code: NETLIFY_CODE, state });
  } finally {
    Object.assign(console, consoleBefore);
  }

  assert.equal(netlify.tokenCalls().length, 1);
  assert.equal(res.statusCode, 500);
  assert.equal(errorOf(res), 'server_error');
  assert.equal(res.headers!.Location, undefined);
  assert.ok(lines.some((line) => line.includes('invalid_client')), 'Netlify error code is logged');
  assert.ok(!lines.some((line) => line.includes('ECHOED-DESCRIPTION')), 'error_description is not logged');
});

test('callback treats a failed, empty or timed-out token response as a server error', async () => {
  const clientId = await registerClient(CLIENT_REDIRECT);
  const state = await authorize(clientId, CLIENT_REDIRECT);

  for (const tokenResponse of [
    () => new Response('unavailable', { status: 503 }),
    () => Response.json({ token_type: 'Bearer' }),
    () => new Response('not json'),
    () => { throw new DOMException('The operation timed out.', 'TimeoutError'); },
  ]) {
    stubNetlify(tokenResponse);
    const res = await callback({ code: NETLIFY_CODE, state });
    assert.equal(res.statusCode, 502);
    assert.equal(errorOf(res), 'server_error');
    assert.equal(res.headers!.Location, undefined);
  }
});

test('callback with an error from Netlify refuses without calling Netlify', async () => {
  const netlify = stubNetlify();
  const clientId = await registerClient(CLIENT_REDIRECT);
  const res = await callback({ error: 'access_denied', state: await authorize(clientId, CLIENT_REDIRECT) });

  assert.equal(res.statusCode, 400);
  assert.equal(errorOf(res), 'access_denied');
  assert.equal(res.headers!.Location, undefined);
  assert.equal(netlify.calls.length, 0);
});

test('callback with no code and no state is an error, not a page, and calls nothing', async () => {
  // What a return with everything in the fragment looks like to the server.
  const netlify = stubNetlify();
  const res = await callback({});

  assert.equal(res.statusCode, 400);
  assert.equal(errorOf(res), 'invalid_request');
  assert.ok(!(res.body as string).includes('<script'));
  assert.equal(netlify.calls.length, 0);
});

test('callback fails closed without NTL_AUTH_CLIENT_SECRET and never calls Netlify', async () => {
  const netlify = stubNetlify();
  const clientId = await registerClient(CLIENT_REDIRECT);
  const initState = await authorize(clientId, CLIENT_REDIRECT);

  delete process.env.NTL_AUTH_CLIENT_SECRET;
  try {
    const res = await callback({ code: NETLIFY_CODE, state: initState });
    assert.equal(res.statusCode, 500);
    assert.equal(errorOf(res), 'server_error');
    assert.equal(res.headers!.Location, undefined);
  } finally {
    process.env.NTL_AUTH_CLIENT_SECRET = CLIENT_SECRET;
  }
  assert.equal(netlify.calls.length, 0);
});

test('every callback response is no-store and sends no referrer', async () => {
  const clientId = await registerClient(CLIENT_REDIRECT);
  const state = await authorize(clientId, CLIENT_REDIRECT);
  const cases: Array<[string, Record<string, string>, number, (() => Response)?]> = [
    ['signed in', { code: NETLIFY_CODE, state }, 302],
    ['declined', { error: 'access_denied' }, 400],
    ['missing params', {}, 400],
    ['unsigned state', { code: NETLIFY_CODE, state: 'not-a-state' }, 400],
    ['code rejected', { code: NETLIFY_CODE, state }, 400, () => new Response('{}', { status: 400 })],
    ['Netlify unavailable', { code: NETLIFY_CODE, state }, 502, () => new Response('', { status: 503 })],
  ];

  for (const [name, params, status, tokenResponse] of cases) {
    stubNetlify(tokenResponse);
    const res = await callback(params);
    assert.equal(res.statusCode, status, name);
    assert.equal(res.headers!['Cache-Control'], 'no-store', name);
    assert.equal(res.headers!['Referrer-Policy'], 'no-referrer', name);
  }
});

test('callback never logs the Netlify code, the Netlify token or the client secret', async () => {
  const clientId = await registerClient(CLIENT_REDIRECT);
  const state = await authorize(clientId, CLIENT_REDIRECT);

  const lines: string[] = [];
  const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  const consoleBefore = { log: console.log, warn: console.warn, error: console.error };
  const verboseBefore = process.env.MCP_VERBOSE_LOGGING;
  process.env.MCP_VERBOSE_LOGGING = 'true';
  Object.assign(console, { log: capture, warn: capture, error: capture });
  try {
    for (const tokenResponse of [undefined, () => new Response('{}', { status: 400 }), () => new Response('', { status: 503 })]) {
      stubNetlify(tokenResponse);
      await callback({ code: NETLIFY_CODE, state });
    }
  } finally {
    Object.assign(console, consoleBefore);
    if (verboseBefore === undefined) {
      delete process.env.MCP_VERBOSE_LOGGING;
    } else {
      process.env.MCP_VERBOSE_LOGGING = verboseBefore;
    }
  }

  assert.ok(lines.some((line) => line.includes('server redirect: issuing authorization code')), 'logs were captured');
  for (const secret of [NETLIFY_CODE, UPSTREAM_TOKEN, CLIENT_SECRET]) {
    assert.ok(!lines.some((line) => line.includes(secret)), `${secret} must not be logged`);
  }
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
