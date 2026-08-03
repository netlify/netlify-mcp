import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Deployed-style issuer so absolute URLs and identity lookups have a stable base.
process.env.OAUTH_ISSUER = 'https://mcp.netlify.example.com';
process.env.NTL_AUTH_CLIENT_ID = process.env.NTL_AUTH_CLIENT_ID || 'test-ntl-client';

const { handler }: any = await import('../oauth-server.ts');

// Importing oauth-server re-points the global logger at the system-log forwarder
// and it writes warn/error to the console. This is a router test, not a logging
// test, so silence both to keep output readable — restored in after().
const origWarn = console.warn;
const origError = console.error;
before(() => {
  console.warn = () => {};
  console.error = () => {};
});
after(() => {
  console.warn = origWarn;
  console.error = origError;
});

function mkEvent(method: string, path: string, body: string | null = null) {
  return {
    rawUrl: `https://mcp.netlify.example.com${path}`,
    path,
    rawQuery: '',
    httpMethod: method,
    headers: { host: 'mcp.netlify.example.com' },
    queryStringParameters: {},
    body,
    isBase64Encoded: false,
  } as any;
}

async function call(method: string, path: string, body: string | null = null) {
  const r: any = await handler(mkEvent(method, path, body), {} as any, () => {});
  const headers: Record<string, string> = r.headers || {};
  const contentType = headers['Content-Type'] || headers['content-type'];
  let json: any = undefined;
  try { json = JSON.parse(r.body); } catch {}
  return { status: r.statusCode, contentType, body: r.body as string, json };
}

test('serves RFC 8414 AS metadata as JSON', async () => {
  const r = await call('GET', '/.well-known/oauth-authorization-server');
  assert.equal(r.status, 200);
  assert.match(r.contentType, /application\/json/);
  assert.equal(r.json.issuer, 'https://mcp.netlify.example.com/');
  assert.deepEqual(r.json.code_challenge_methods_supported, ['S256']);
});

test('AS metadata is reachable at the function-prefixed well-known path too', async () => {
  // netlify.toml routes /oauth-server/* here, so clients may hit the metadata at
  // a prefixed path; endsWith matching must still resolve it.
  const r = await call('GET', '/oauth-server/.well-known/oauth-authorization-server');
  assert.equal(r.status, 200);
  assert.equal(r.json.issuer, 'https://mcp.netlify.example.com/');
});

test('openid-configuration is a byte-identical alias of the AS metadata', async () => {
  const as = await call('GET', '/.well-known/oauth-authorization-server');
  const oidc = await call('GET', '/.well-known/openid-configuration');
  assert.equal(oidc.status, 200);
  assert.equal(oidc.body, as.body);
});

test('serves RFC 9728 protected-resource metadata as JSON', async () => {
  const r = await call('GET', '/.well-known/oauth-protected-resource/mcp');
  assert.equal(r.status, 200);
  assert.equal(r.json.resource, 'https://mcp.netlify.example.com/mcp');
  assert.deepEqual(r.json.authorization_servers, ['https://mcp.netlify.example.com/']);
});

test('CORS preflight returns 204', async () => {
  const r = await call('OPTIONS', '/oauth-server/token');
  assert.equal(r.status, 204);
});

test('authorize and token endpoints are still routed to their handlers', async () => {
  // No params -> the real handlers reject with 400 (not 404), proving the route
  // reaches handleAuthStart / handleCodeExchange rather than the fallback.
  const auth = await call('GET', '/oauth-server/auth');
  assert.equal(auth.status, 400);
  assert.equal(auth.json.error, 'invalid_request');

  const token = await call('POST', '/oauth-server/token', '');
  assert.equal(token.status, 400);
  assert.equal(token.json.error, 'invalid_request');
});

test('removed endpoints return a clean 404 invalid_request', async () => {
  // Everything that used to be served by the OIDC provider catch-all is gone.
  for (const path of [
    '/oauth-server/token/introspection',
    '/oauth-server/token/revocation',
    '/oauth-server/device/auth',
    '/oauth-server/backchannel',
    '/oauth-server/request', // pushed authorization request
    '/oauth-server/me',      // userinfo
    '/404-jwks',
    '/oauth-server/nonsense',
  ]) {
    const r = await call('GET', path);
    assert.equal(r.status, 404, `${path} should 404`);
    assert.equal(r.json.error, 'invalid_request', `${path} should be invalid_request`);
  }
});

test('GET on the registration endpoint (management, unsupported) is 404', async () => {
  // Registration is POST-only; RFC 7592 management is not supported.
  const r = await call('GET', '/oauth-server/reg');
  assert.equal(r.status, 404);
});
