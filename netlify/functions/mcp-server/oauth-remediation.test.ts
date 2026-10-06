import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createJWE } from './utils.ts';
import { getClientById } from './oauth-clients.ts';
import {
  issueToken,
  LEGACY_ACCESS_TOKEN_SUNSET,
  TokenError,
  verifyToken,
} from './tokens.ts';
import {
  getOAuthStore,
  MemoryOAuthStore,
  OAuthStorageError,
  setOAuthStore,
  type OAuthStore,
} from './oauth-store.ts';
import { handleClientRegistration } from './auth-flow.ts';
import { handleProxy } from '../../edge-functions/proxy.ts';
import { SUPPORTED_SCOPES } from './oauth-config.ts';
import { getBearerCredential, getTokenIdentity, userIsAuthenticated } from '../../../src/utils/api-networking.ts';
import {
  approve,
  callback,
  completeFlow,
  consentPage,
  csrfFrom,
  decide,
  exchange,
  finish,
  ISSUER,
  location,
  obtainTokens,
  pkcePair,
  register,
  revoke,
  startFlow,
} from './oauth-test-flow.ts';

process.env.OAUTH_ISSUER = ISSUER;
process.env.OAUTH_STORE = 'memory';
delete process.env.JWE_SECRET;

const REDIRECT_A = 'https://client-a.example.com/callback';
const REDIRECT_B = 'https://client-b.example.net/callback';
const MCP_URL = `${ISSUER}/mcp`;

const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
const origFetch = globalThis.fetch;
// Every upstream call a test can trigger: the identity lookup at the callback
// and the /api/v1/user probe at /mcp. Both answer locally; a test that must
// know whether upstream was reached counts the calls.
let upstreamCalls: string[] = [];
before(() => {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    upstreamCalls.push(url);
    return new Response(JSON.stringify({ id: 'user-1', account_id: 'team-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});
after(() => {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;
  globalThis.fetch = origFetch;
});
beforeEach(() => {
  upstreamCalls = [];
  setOAuthStore(new MemoryOAuthStore());
});

function mcpRequest(bearer: string | null) {
  return new Request(MCP_URL, {
    method: 'POST',
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    body: '{}',
  });
}

async function rejectedAtMcp(bearer: string): Promise<string> {
  try {
    await getBearerCredential(mcpRequest(bearer));
  } catch (error: any) {
    return error.name;
  }
  return 'accepted';
}

function proxyRequest(token: string, path: string, method = 'POST') {
  return new Request(`https://mcp.example/proxy/${token}${path}`, { method });
}

function body(res: any) {
  return JSON.parse(res.body as string);
}

/** Every token type this server issues, minted directly for a synthetic grant. */
async function oneOfEach() {
  const base = { grant: 'grant-x', client_id: 'client-x', accessToken: 'nf-upstream-token' };
  return {
    code: await issueToken<'code'>({ typ: 'code', ...base, redirect_uri: REDIRECT_A, code_challenge: pkcePair().challenge, code_challenge_method: 'S256' }),
    access: await issueToken<'access'>({ typ: 'access', ...base }),
    refresh: await issueToken<'refresh'>({ typ: 'refresh', ...base }),
    proxy: await issueToken<'proxy'>({ typ: 'proxy', ...base, apisAllowed: [{ path: '/api/v1/sites/abc/builds', method: 'POST' }] }),
    registration: await register([REDIRECT_A]),
  };
}

// ---------------------------------------------------------------------------
// 1. Token purpose at every consumer
// ---------------------------------------------------------------------------

test('verifyToken accepts each type only as itself and names why it refuses the rest', async () => {
  const tokens = await oneOfEach();
  for (const [type, token] of Object.entries(tokens) as Array<[string, string]>) {
    for (const expected of ['code', 'access', 'refresh', 'proxy'] as const) {
      if (type === expected) {
        const claims = await verifyToken(token, expected);
        assert.equal(claims.typ, expected);
        continue;
      }
      await assert.rejects(verifyToken(token, expected), (error: any) => {
        assert.ok(error instanceof TokenError);
        assert.equal(error.reason, 'wrong_purpose', `${type} presented as ${expected}`);
        return true;
      });
    }
  }
});

test('/mcp accepts only access tokens and PATs, and refuses the rest before any upstream call', async () => {
  const tokens = await oneOfEach();
  for (const [type, token] of Object.entries(tokens)) {
    if (type === 'access') continue;
    upstreamCalls = [];
    assert.equal(await rejectedAtMcp(token), 'NetlifyUnauthError', `${type} at /mcp`);
    assert.equal(await userIsAuthenticated(mcpRequest(token)), false, `${type} at /mcp`);
    assert.deepEqual(upstreamCalls, [], `${type} must be refused before upstream is called`);
  }
  // Garbage and absence are refused too.
  assert.equal(await rejectedAtMcp('not-a-token'), 'NetlifyUnauthError');
  assert.equal(await userIsAuthenticated(mcpRequest(null)), false);
});

test('/mcp keeps accepting a raw Netlify personal access token as-is', async () => {
  for (const pat of ['nfp_abc123', 'nfu_abc123', 'nfo_abc123']) {
    const credential = await getBearerCredential(mcpRequest(pat));
    assert.deepEqual(credential, { kind: 'pat', accessToken: pat });
    assert.equal(await userIsAuthenticated(mcpRequest(pat)), true);
    assert.equal(await getTokenIdentity(mcpRequest(pat)), null);
  }
});

test('/proxy accepts only proxy tokens', async () => {
  const tokens = await oneOfEach();
  for (const [type, token] of Object.entries(tokens)) {
    upstreamCalls = [];
    const res = await handleProxy(proxyRequest(token, '/api/v1/sites/abc/builds'), token);
    if (type === 'proxy') {
      assert.equal(res.status, 200, 'the proxy token itself is forwarded');
      assert.equal(upstreamCalls.length, 1);
    } else {
      assert.equal(res.status, 401, `${type} at /proxy`);
      assert.deepEqual(upstreamCalls, [], `${type} must be refused before anything is forwarded`);
    }
  }
});

test('/proxy enforces the token allowlist against the forwarded path and method', async () => {
  const token = await issueToken<'proxy'>({
    typ: 'proxy', grant: null, client_id: null, accessToken: 'nfp_pat',
    apisAllowed: [{ path: '/api/v1/sites/abc/builds', method: 'POST' }, { path: '/api/v1/deploys/:deploy_id', method: 'GET' }],
  });
  assert.equal((await handleProxy(proxyRequest(token, '/api/v1/sites/abc/builds', 'POST'), token)).status, 200);
  assert.equal((await handleProxy(proxyRequest(token, '/api/v1/deploys/dep1', 'GET'), token)).status, 200);
  // Right path, wrong method.
  assert.equal((await handleProxy(proxyRequest(token, '/api/v1/sites/abc/builds', 'GET'), token)).status, 403);
  assert.equal((await handleProxy(proxyRequest(token, '/api/v1/deploys/dep1', 'DELETE'), token)).status, 403);
  // Another site, a traversal, an unrelated endpoint.
  assert.equal((await handleProxy(proxyRequest(token, '/api/v1/sites/other/builds', 'POST'), token)).status, 403);
  assert.equal((await handleProxy(proxyRequest(token, '/api/v1/sites/abc/builds/../../../accounts/team/env', 'POST'), token)).status, 403);
  assert.equal((await handleProxy(proxyRequest(token, '/api/v1/accounts/team/env', 'GET'), token)).status, 403);
  // The forwarded request uses the real method; nothing in the token can override it.
  const forwarded = upstreamCalls.length;
  assert.ok(forwarded >= 2);
});

test('/proxy refuses a proxy-shaped token that has no allowlist', async () => {
  const noAllowlist = await createJWE({ typ: 'proxy', jti: 'x', grant: null, client_id: null, accessToken: 'nfp_pat', iss: ISSUER + '/', aud: `${ISSUER}/proxy` }, '30m');
  const res = await handleProxy(proxyRequest(noAllowlist, '/api/v1/sites/abc/builds'), noAllowlist);
  assert.equal(res.status, 401);
});

test('tokens are bound to this issuer and to the consuming endpoint', async () => {
  const foreign = await createJWE({ typ: 'access', jti: 'x', grant: null, client_id: null, accessToken: 'nf' }, '1h', undefined, { issuer: 'https://other.example/', audience: 'https://other.example/mcp' });
  await assert.rejects(verifyToken(foreign, 'access'), (e: any) => e.reason === 'wrong_issuer');
  const wrongAud = await createJWE({ typ: 'access', jti: 'x', grant: null, client_id: null, accessToken: 'nf' }, '1h', undefined, { issuer: ISSUER + '/', audience: `${ISSUER}/proxy` });
  await assert.rejects(verifyToken(wrongAud, 'access'), (e: any) => e.reason === 'wrong_audience');
  const malformed = await createJWE({ typ: 'access', grant: null, client_id: null }, '1h', undefined, { issuer: ISSUER + '/', audience: `${ISSUER}/mcp` });
  await assert.rejects(verifyToken(malformed, 'access'), (e: any) => e.reason === 'malformed');
});

// ---------------------------------------------------------------------------
// 2. Consent and session-bound transactions
// ---------------------------------------------------------------------------

test('consent names the requesting application as unverified, shows the destination and the effective access', async () => {
  const clientId = await register([REDIRECT_A], 'Evil <script>alert(1)</script> Corp');
  const flow = await startFlow(clientId, REDIRECT_A, pkcePair().challenge, 'read write offline_access bogus');
  assert.match(flow.consentHtml, /Unverified application/);
  assert.match(flow.consentHtml, /Evil &lt;script&gt;alert\(1\)&lt;\/script&gt; Corp/);
  assert.doesNotMatch(flow.consentHtml, /<script>alert/);
  assert.match(flow.consentHtml, /client-a\.example\.com/);
  assert.match(flow.consentHtml, /full access of your Netlify login/);
  assert.match(flow.consentHtml, /offline_access/);
  assert.doesNotMatch(flow.consentHtml, /bogus/, 'unsupported scopes are not presented as granted');
  const page = await consentPage(flow.txn, flow.cookie);
  assert.equal(page.headers?.['X-Frame-Options'], 'DENY');
  assert.match(String(page.headers?.['Content-Security-Policy']), /frame-ancestors 'none'/);
});

test('consent cannot be read or approved without the session cookie that started it', async () => {
  const clientId = await register([REDIRECT_A]);
  const flow = await startFlow(clientId, REDIRECT_A, pkcePair().challenge);

  const noCookie = await consentPage(flow.txn, null);
  assert.equal(noCookie.statusCode, 400);
  const otherBrowser = await consentPage(flow.txn, 'netlify_mcp_oauth=' + 'C'.repeat(43));
  assert.equal(otherBrowser.statusCode, 400);

  const approveNoCookie = await decide({ txn: flow.txn, csrf: flow.csrf, decision: 'approve' }, null);
  assert.equal(approveNoCookie.statusCode, 400);
  const approveOtherBrowser = await decide({ txn: flow.txn, csrf: flow.csrf, decision: 'approve' }, 'netlify_mcp_oauth=' + 'C'.repeat(43));
  assert.equal(approveOtherBrowser.statusCode, 400);
  const approveBadCsrf = await decide({ txn: flow.txn, csrf: 'forged', decision: 'approve' }, flow.cookie);
  assert.equal(approveBadCsrf.statusCode, 400);
  assert.equal(body(approveBadCsrf).error, 'invalid_request');

  // After all that, the real browser can still approve exactly once.
  const netlify = await approve(flow);
  assert.equal(netlify.searchParams.get('state'), flow.txn);
  const again = await decide({ txn: flow.txn, csrf: flow.csrf, decision: 'approve' }, flow.cookie);
  assert.equal(again.statusCode, 400);
});

test('declined consent sends access_denied to the registered redirect and the transaction is dead', async () => {
  const clientId = await register([REDIRECT_A]);
  const flow = await startFlow(clientId, REDIRECT_A, pkcePair().challenge);
  const res = await decide({ txn: flow.txn, csrf: flow.csrf, decision: 'deny' }, flow.cookie);
  assert.equal(res.statusCode, 302);
  const target = location(res);
  assert.equal(`${target.origin}${target.pathname}`, REDIRECT_A);
  assert.equal(target.searchParams.get('error'), 'access_denied');
  assert.equal(target.searchParams.get('state'), 'client-state');
  // The callback for a declined transaction mints nothing.
  const cb = await callback({ token: 'tok', state: flow.txn }, flow.cookie);
  assert.equal(cb.statusCode, 400);
  assert.equal(cb.headers?.Location, undefined);
});

test('the callback requires an approved, unexpired transaction owned by this browser', async () => {
  const clientId = await register([REDIRECT_A]);

  // Pending (consent skipped): the browser went straight to the callback.
  const skipped = await startFlow(clientId, REDIRECT_A, pkcePair().challenge);
  const direct = await callback({ token: 'tok', state: skipped.txn }, skipped.cookie);
  assert.equal(direct.statusCode, 400);
  assert.equal(direct.headers?.Location, undefined);

  // Approved, but a different browser posts the token.
  const approved = await startFlow(clientId, REDIRECT_A, pkcePair().challenge);
  const netlify = await approve(approved);
  const stolen = await callback({ token: 'tok', state: netlify.searchParams.get('state') as string }, 'netlify_mcp_oauth=' + 'D'.repeat(43));
  assert.equal(stolen.statusCode, 400);
  const noCookie = await callback({ token: 'tok', state: netlify.searchParams.get('state') as string }, null);
  assert.equal(noCookie.statusCode, 400);

  // The right browser completes it once; a replay of the same POST mints no second code.
  const first = await finish(approved, netlify);
  assert.equal(first.statusCode, 302);
  const replay = await finish(approved, netlify);
  assert.equal(replay.statusCode, 400);
  assert.equal(replay.headers?.Location, undefined);

  // Expired: approved ten minutes ago.
  const stale = await startFlow(clientId, REDIRECT_A, pkcePair().challenge);
  const staleNetlify = await approve(stale);
  const store = getOAuthStore();
  const found = await store.getTransaction(stale.txn);
  assert.ok(found);
  await store.updateTransaction({ ...found.record, expiresAt: Date.now() - 1 }, found.etag);
  const expired = await finish(stale, staleNetlify);
  assert.equal(expired.statusCode, 400);
  assert.equal(expired.headers?.Location, undefined);
});

test('the transaction record is authoritative: nothing the browser sends can change client or redirect', async () => {
  const clientId = await register([REDIRECT_A]);
  const flow = await startFlow(clientId, REDIRECT_A, pkcePair().challenge);
  const netlify = await approve(flow);
  // Extra fields on the callback are ignored; the code goes to the recorded redirect.
  const res = await callback({ token: 'tok', state: netlify.searchParams.get('state') as string, redirect_uri: REDIRECT_B, client_id: 'other' }, flow.cookie);
  assert.equal(res.statusCode, 302);
  assert.equal(`${location(res).origin}${location(res).pathname}`, REDIRECT_A);
});

test('a newly registered client cannot inherit approval granted to another client', async () => {
  const clientA = await register([REDIRECT_A], 'Client A');
  const clientB = await register([REDIRECT_B], 'Client B');
  const { verifier, challenge } = pkcePair();
  const flow = await completeFlow(clientA, REDIRECT_A, challenge, 'offline_access');

  // B holds the code (say, it leaked) and its own registration.
  for (const attempt of [
    { client_id: clientB, redirect_uri: REDIRECT_B },
    { client_id: clientB, redirect_uri: REDIRECT_A },
    { client_id: clientA, redirect_uri: REDIRECT_B },
  ]) {
    const res = await exchange({ grant_type: 'authorization_code', code: flow.code, code_verifier: verifier, ...attempt });
    assert.equal(res.statusCode, 400);
    assert.equal(body(res).error, 'invalid_grant');
  }
  // A's own exchange still works: the failed attempts above never redeemed the code.
  const ok = await exchange({ grant_type: 'authorization_code', code: flow.code, client_id: clientA, redirect_uri: REDIRECT_A, code_verifier: verifier });
  assert.equal(ok.statusCode, 200);
  // And B cannot refresh A's grant.
  const refreshAsB = await exchange({ grant_type: 'refresh_token', refresh_token: body(ok).refresh_token, client_id: clientB });
  assert.equal(refreshAsB.statusCode, 400);
  assert.equal(body(refreshAsB).error, 'invalid_grant');
  // B's own flow, same browser cookie or not, cannot use A's transaction.
  const flowB = await startFlow(clientB, REDIRECT_B, pkcePair().challenge);
  const crossed = await callback({ token: 'tok', state: flow.txn }, flowB.cookie);
  assert.equal(crossed.statusCode, 400);
});

// ---------------------------------------------------------------------------
// 3. Replay prevention and grant lifecycle
// ---------------------------------------------------------------------------

test('an authorization code is redeemable once; a replay revokes the grant and its tokens', async () => {
  const clientId = await register([REDIRECT_A]);
  const { verifier, challenge } = pkcePair();
  const flow = await completeFlow(clientId, REDIRECT_A, challenge, 'offline_access');
  const form = { grant_type: 'authorization_code', code: flow.code, client_id: clientId, redirect_uri: REDIRECT_A, code_verifier: verifier };

  const first = await exchange(form);
  assert.equal(first.statusCode, 200);
  const { access_token, refresh_token } = body(first) as { access_token: string; refresh_token: string };
  assert.equal(await userIsAuthenticated(mcpRequest(access_token)), true);

  const replay = await exchange(form);
  assert.equal(replay.statusCode, 400);
  assert.equal(body(replay).error, 'invalid_grant');

  // Revocation reaches the resource server and the refresh family.
  assert.equal(await userIsAuthenticated(mcpRequest(access_token)), false);
  const refresh = await exchange({ grant_type: 'refresh_token', refresh_token, client_id: clientId });
  assert.equal(refresh.statusCode, 400);
});

test('concurrent redemptions of one code yield exactly one token response', async () => {
  const clientId = await register([REDIRECT_A]);
  const { verifier, challenge } = pkcePair();
  const flow = await completeFlow(clientId, REDIRECT_A, challenge);
  const form = { grant_type: 'authorization_code', code: flow.code, client_id: clientId, redirect_uri: REDIRECT_A, code_verifier: verifier };
  const results = await Promise.all(Array.from({ length: 8 }, () => exchange(form)));
  const statuses = results.map((r) => r.statusCode).sort();
  assert.equal(statuses.filter((s) => s === 200).length, 1, `statuses: ${statuses}`);
  assert.equal(statuses.filter((s) => s === 400).length, 7);
});

test('refresh rotation invalidates the previous token and reuse revokes the whole family', async () => {
  const clientId = await register([REDIRECT_A]);
  const { access_token, refresh_token } = await obtainTokens(clientId, REDIRECT_A) as { access_token: string; refresh_token: string };
  assert.ok(refresh_token);

  const rotated = await exchange({ grant_type: 'refresh_token', refresh_token, client_id: clientId });
  assert.equal(rotated.statusCode, 200);
  const second = body(rotated);
  assert.notEqual(second.refresh_token, refresh_token);
  assert.equal(await userIsAuthenticated(mcpRequest(second.access_token)), true);
  assert.equal(await userIsAuthenticated(mcpRequest(access_token)), true, 'an earlier access token lives until it expires or the grant is revoked');

  // Presenting the rotated-out token is reuse.
  const reuse = await exchange({ grant_type: 'refresh_token', refresh_token, client_id: clientId });
  assert.equal(reuse.statusCode, 400);
  assert.equal(body(reuse).error, 'invalid_grant');

  // The family is gone: the newest refresh token and every access token.
  const afterReuse = await exchange({ grant_type: 'refresh_token', refresh_token: second.refresh_token, client_id: clientId });
  assert.equal(afterReuse.statusCode, 400);
  assert.equal(await userIsAuthenticated(mcpRequest(second.access_token)), false);
  assert.equal(await userIsAuthenticated(mcpRequest(access_token)), false);
});

test('concurrent refreshes with one token succeed at most once', async () => {
  const clientId = await register([REDIRECT_A]);
  const { refresh_token } = await obtainTokens(clientId, REDIRECT_A) as { refresh_token: string };
  const results = await Promise.all(Array.from({ length: 6 }, () => exchange({ grant_type: 'refresh_token', refresh_token, client_id: clientId })));
  const ok = results.filter((r) => r.statusCode === 200);
  assert.ok(ok.length <= 1, `expected at most one success, got ${ok.length}`);
  assert.equal(results.length - ok.length, results.filter((r) => r.statusCode === 400).length);
});

test('refresh requires the client the token was issued to', async () => {
  const clientId = await register([REDIRECT_A]);
  const { refresh_token } = await obtainTokens(clientId, REDIRECT_A) as { refresh_token: string };
  const missing = await exchange({ grant_type: 'refresh_token', refresh_token });
  assert.equal(missing.statusCode, 400);
  assert.equal(body(missing).error, 'invalid_request');
  const other = await exchange({ grant_type: 'refresh_token', refresh_token, client_id: await register([REDIRECT_B]) });
  assert.equal(other.statusCode, 400);
  assert.equal(body(other).error, 'invalid_grant');
  // Neither attempt counted as reuse: the real client still rotates.
  const ok = await exchange({ grant_type: 'refresh_token', refresh_token, client_id: clientId });
  assert.equal(ok.statusCode, 200);
});

test('RFC 7009 revocation of either token ends access for the grant', async () => {
  const clientId = await register([REDIRECT_A]);
  const { access_token, refresh_token } = await obtainTokens(clientId, REDIRECT_A);
  assert.equal(await userIsAuthenticated(mcpRequest(access_token)), true);
  const res = await revoke({ token: access_token, client_id: clientId });
  assert.equal(res.statusCode, 200);
  assert.equal(await userIsAuthenticated(mcpRequest(access_token)), false);
  const refresh = await exchange({ grant_type: 'refresh_token', refresh_token: refresh_token as string, client_id: clientId });
  assert.equal(refresh.statusCode, 400);
  // Unknown tokens are answered 200 without revealing anything.
  assert.equal((await revoke({ token: 'nonsense' })).statusCode, 200);
});

class FailingStore implements OAuthStore {
  private readonly inner: OAuthStore;
  private failing = false;
  constructor(inner: OAuthStore) { this.inner = inner; }
  fail() { this.failing = true; }
  private guard<T>(work: () => Promise<T>): Promise<T> {
    if (this.failing) return Promise.reject(new OAuthStorageError('blobs down (test)'));
    return work();
  }
  putTransaction(t: any) { return this.guard(() => this.inner.putTransaction(t)); }
  getTransaction(id: string) { return this.guard(() => this.inner.getTransaction(id)); }
  updateTransaction(t: any, e: string) { return this.guard(() => this.inner.updateTransaction(t, e)); }
  putGrant(g: any) { return this.guard(() => this.inner.putGrant(g)); }
  getGrant(id: string) { return this.guard(() => this.inner.getGrant(id)); }
  updateGrant(g: any, e: string) { return this.guard(() => this.inner.updateGrant(g, e)); }
  redeemCode(j: string) { return this.guard(() => this.inner.redeemCode(j)); }
}

test('a storage failure fails closed at every endpoint that depends on it', async () => {
  const store = new FailingStore(new MemoryOAuthStore());
  setOAuthStore(store);
  const clientId = await register([REDIRECT_A]);
  const { verifier, challenge } = pkcePair();
  const flow = await completeFlow(clientId, REDIRECT_A, challenge, 'offline_access');
  const { access_token, refresh_token } = await obtainTokens(clientId, REDIRECT_A);

  store.fail();
  const auth = await startFlow(clientId, REDIRECT_A, pkcePair().challenge).catch((e) => e);
  assert.ok(auth instanceof Error, '/auth cannot proceed without recording the transaction');
  const consent = await consentPage(flow.txn, flow.cookie);
  assert.equal(consent.statusCode, 503);
  const cb = await callback({ token: 'tok', state: flow.txn }, flow.cookie);
  assert.equal(cb.statusCode, 503);
  const code = await exchange({ grant_type: 'authorization_code', code: flow.code, client_id: clientId, redirect_uri: REDIRECT_A, code_verifier: verifier });
  assert.equal(code.statusCode, 503);
  assert.equal(body(code).error, 'temporarily_unavailable');
  assert.match(body(code).error_description, /blobs down/);
  const refresh = await exchange({ grant_type: 'refresh_token', refresh_token: refresh_token as string, client_id: clientId });
  assert.equal(refresh.statusCode, 503);
  await assert.rejects(userIsAuthenticated(mcpRequest(access_token)), (e: any) => e instanceof OAuthStorageError);
  const revoked = await revoke({ token: access_token, client_id: clientId });
  assert.equal(revoked.statusCode, 503);
});

// ---------------------------------------------------------------------------
// 4. Registration boundaries
// ---------------------------------------------------------------------------

async function tryRegister(redirectUris: string[]) {
  return handleClientRegistration(new Request(`${ISSUER}/oauth-server/reg`, { method: 'POST', body: JSON.stringify({ redirect_uris: redirectUris }) }), SUPPORTED_SCOPES);
}

test('registration accepts https, loopback and private-scheme redirects and refuses the rest', async () => {
  for (const ok of ['https://example.com/cb', 'https://example.com/cb?x=1', 'http://127.0.0.1:1234/cb', 'http://localhost/cb', 'http://[::1]:5000/cb', 'cursor://anysphere.cursor-mcp/callback', 'com.example.app:/oauth']) {
    assert.equal((await tryRegister([ok])).statusCode, 201, ok);
  }
  for (const bad of ['http://example.com/cb', 'https://example.com/cb#frag', 'https://user:pw@example.com/cb', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'not a url', `https://example.com/${'a'.repeat(3000)}`]) {
    const res = await tryRegister([bad]);
    assert.equal(res.statusCode, 400, bad);
    assert.equal(body(res).error, 'invalid_redirect_uri', bad);
  }
  // One bad URI fails the whole registration; nothing is partially registered.
  assert.equal((await tryRegister(['https://example.com/cb', 'http://example.com/cb'])).statusCode, 400);
});

test('the pinned ChatGPT client keeps its exact callback and a static client is never a DCR client', async () => {
  const chatgpt = getClientById('2m93QbON-vPRJMMIGA_MEzG1fkejj4JNAgb97ZC3gPd');
  assert.ok(chatgpt);
  assert.deepEqual(chatgpt.redirect_uris, ['https://chatgpt.com/connector_platform_oauth_redirect']);
  assert.equal(chatgpt.client_name, 'ChatGPT');
});

// ---------------------------------------------------------------------------
// 5. Migration
// ---------------------------------------------------------------------------

async function legacyAccessToken() {
  return createJWE({ accessToken: 'nf-legacy', identity: { userId: 'u1', teamId: 't1' } }, '48h');
}

test('a legacy access token is accepted at /mcp inside the sunset window and nowhere else', async () => {
  const legacy = await legacyAccessToken();
  const realNow = Date.now;
  try {
    Date.now = () => LEGACY_ACCESS_TOKEN_SUNSET - 1000;
    const credential = await getBearerCredential(mcpRequest(legacy));
    assert.equal(credential.kind, 'oauth');
    assert.equal((credential as any).claims.legacy, true);
    assert.equal(await userIsAuthenticated(mcpRequest(legacy)), true);
    assert.deepEqual(await getTokenIdentity(mcpRequest(legacy)), { userId: 'u1', teamId: 't1' });
    // Not at /proxy, not as a code, not as a refresh token.
    assert.equal((await handleProxy(proxyRequest(legacy, '/api/v1/sites/abc/builds'), legacy)).status, 401);
    await assert.rejects(verifyToken(legacy, 'code'), (e: any) => e.reason === 'wrong_purpose');
    await assert.rejects(verifyToken(legacy, 'refresh'), (e: any) => e.reason === 'wrong_purpose');
  } finally {
    Date.now = realNow;
  }
});

test('the legacy window closes at the sunset: the same token is then refused', async () => {
  const legacy = await legacyAccessToken();
  const realNow = Date.now;
  try {
    Date.now = () => LEGACY_ACCESS_TOKEN_SUNSET;
    await assert.rejects(verifyToken(legacy, 'access'), (e: any) => e.reason === 'legacy_expired');
    assert.equal(await rejectedAtMcp(legacy), 'NetlifyUnauthError');
  } finally {
    Date.now = realNow;
  }
});

test('legacy shapes with any extra field are never taken for an access token', async () => {
  for (const payload of [
    { accessToken: 'nf', type: 'refresh' },                       // legacy refresh token
    { accessToken: 'nf', siteId: 's', apisAllowed: [] },          // legacy proxy token
    { accessToken: 'nf', state: { client_id: 'c' } },             // legacy authorization code
    { token_use: 'client_registration', redirect_uris: ['x'] },   // a client registration
    { accessToken: 'nf', identity: {}, extra: 1 },
  ]) {
    const token = await createJWE(payload, '1h');
    assert.equal(await rejectedAtMcp(token), 'NetlifyUnauthError', JSON.stringify(payload));
  }
});

test('a legacy refresh token is answered with a reconnect, not a rotation', async () => {
  const legacyRefresh = await createJWE({ accessToken: 'nf-legacy', type: 'refresh' }, '7d');
  const res = await exchange({ grant_type: 'refresh_token', refresh_token: legacyRefresh, client_id: 'any-client' });
  assert.equal(res.statusCode, 400);
  assert.equal(body(res).error, 'invalid_grant');
  assert.match(body(res).error_description, /reconnect/i);
  // The submitted client_id did not conjure a binding: no grant was created.
  assert.equal(await userIsAuthenticated(mcpRequest(legacyRefresh)), false);
});

test('a legacy authorization code can no longer be exchanged', async () => {
  const legacyCode = await createJWE({ accessToken: 'nf-legacy', state: { client_id: 'c', redirect_uri: REDIRECT_A, code_challenge: 'x', code_challenge_method: 'S256' } }, '1h');
  const res = await exchange({ grant_type: 'authorization_code', code: legacyCode, client_id: 'c', redirect_uri: REDIRECT_A, code_verifier: 'v' });
  assert.equal(res.statusCode, 400);
  assert.equal(body(res).error, 'invalid_grant');
});

test('the consent page and callback are not reachable with the pre-#63 base64 init-state', async () => {
  const initState = Buffer.from(JSON.stringify({ response_type: 'code', code_challenge_method: 'S256', client_id: 'x', redirect_uri: REDIRECT_B, code_challenge: 'c' })).toString('base64');
  const res = await callback({ token: 'tok', 'init-state': initState }, null);
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers?.Location, undefined);
});

test('no token, code, cookie or raw state reaches the logs', async () => {
  const lines: string[] = [];
  const quiet = console.log;
  const quietWarn = console.warn;
  const quietError = console.error;
  console.log = (line: string) => { lines.push(String(line)); };
  console.warn = (line: string) => { lines.push(String(line)); };
  console.error = (line: string) => { lines.push(String(line)); };
  try {
    const clientId = await register([REDIRECT_A]);
    const { access_token, refresh_token, flow, verifier } = await obtainTokens(clientId, REDIRECT_A);
    await exchange({ grant_type: 'refresh_token', refresh_token: refresh_token as string, client_id: clientId });
    await exchange({ grant_type: 'authorization_code', code: flow.code, client_id: clientId, redirect_uri: REDIRECT_A, code_verifier: verifier });
    await userIsAuthenticated(mcpRequest(access_token));
    const joined = lines.join('\n');
    for (const secret of [flow.code, access_token, refresh_token as string, flow.cookie.split('=')[1], flow.csrf, 'netlify-token-from-browser']) {
      assert.ok(!joined.includes(secret), `log lines must not contain ${secret.slice(0, 12)}…`);
    }
  } finally {
    console.log = quiet;
    console.warn = quietWarn;
    console.error = quietError;
  }
});
