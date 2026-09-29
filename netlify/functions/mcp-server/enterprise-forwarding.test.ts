import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { forwardEnterpriseGrant } from './enterprise-forwarding.ts';
import { decryptJWE } from './utils.ts';
import { handleCodeExchange } from './auth-flow.ts';

const endpoint = 'https://api.example.test/oauth/ema/token';
const resource = 'https://mcp.example.test/mcp';
const body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=original%2Bproof&scope=site%3Aread&resource=https%3A%2F%2Fmcp.example.test%2Fmcp&client_assertion=client-proof';
const authorization = 'Basic Y2xpZW50OnNlY3JldA==';
const tokenResponse = { access_token: 'bounded-backend-token', token_type: 'Bearer', expires_in: 120, scope: 'site:read', resource };

function request() {
  return new Request('https://mcp.example.test/oauth-server/token', {
    method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: authorization, Cookie: 'do-not-forward' },
  });
}

test('forwards the original request and bounds the JWE to backend expiry', async (t) => {
  const started = Math.floor(Date.now() / 1000);
  t.mock.method(Date, 'now', () => started * 1000);
  const fetchToken: typeof fetch = async (url, init) => {
    assert.equal(String(url), endpoint);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.body, body);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), authorization);
    assert.equal(headers.get('cookie'), null);
    assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
    return Response.json(tokenResponse);
  };
  const response = await forwardEnterpriseGrant(request(), body, { endpoint, resource, fetchToken });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers?.['Pragma'], 'no-cache');
  const result = JSON.parse(response.body!);
  assert.equal(result.resource, resource);
  assert.equal(result.scope, 'site:read');
  assert.equal(result.refresh_token, undefined);
  assert.ok(result.expires_in > 0 && result.expires_in <= 120);
  const payload = await decryptJWE(result.access_token);
  assert.equal(payload.accessToken, tokenResponse.access_token);
  assert.equal(payload.scope, tokenResponse.scope);
  assert.equal(payload.resource, resource);
  assert.equal(payload.type, 'ema');
  assert.ok(payload.exp! <= started + 120);
  const refreshed = await handleCodeExchange(new Request('http://localhost:8888/oauth-server/token', {
    method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: result.access_token }),
  }));
  assert.equal(refreshed.statusCode, 400);
  assert.equal(JSON.parse(refreshed.body!).error, 'invalid_grant');
});

test('network delay consumes lifetime rather than extending the wrapper', async () => {
  const started = Math.floor(Date.now() / 1000);
  const clock = mock.method(Date, 'now', () => started * 1000);
  try {
    const result = await forwardEnterpriseGrant(request(), body, {
      endpoint, resource, fetchToken: async () => {
        clock.mock.mockImplementation(() => (started + 15) * 1000);
        return Response.json(tokenResponse);
      },
    });
    assert.equal(result.statusCode, 200);
    const wrapped = JSON.parse(result.body!);
    assert.equal(wrapped.expires_in, 105);
    assert.equal((await decryptJWE(wrapped.access_token)).exp, started + 120);
  } finally {
    clock.mock.restore();
  }
});

test('rejects unsafe endpoint configuration without sending credentials', async () => {
  const fetchToken: typeof fetch = async () => { assert.fail('must not fetch'); };
  for (const target of ['http://api.example.test/token', 'https://user:password@api.example.test/token', 'https://api.example.test/token?redirect=other', 'https://api.example.test/token#fragment', 'invalid']) {
    const response = await forwardEnterpriseGrant(request(), body, { endpoint: target, resource, fetchToken });
    assert.equal(response.statusCode, 503);
    assert.ok(!response.body!.includes('password'));
  }
});

test('returns the OAuth error code without echoing upstream secret material', async () => {
  const response = await forwardEnterpriseGrant(request(), body, {
    endpoint, resource, fetchToken: async () => Response.json({ error: 'invalid_client', error_description: 'secret-proof' }, { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Netlify"', 'Set-Cookie': 'secret' } }),
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers?.['WWW-Authenticate'], 'Basic realm="Netlify"');
  assert.equal(response.headers?.['Set-Cookie'], undefined);
  assert.deepEqual(JSON.parse(response.body!), { error: 'invalid_client' });
  assert.match(String(response.headers?.['Cache-Control']), /no-store/);
});

test('fails closed on redirects, network errors and malformed responses', async () => {
  const replies = [
    () => new Response(null, { status: 302, headers: { Location: 'https://other.test' } }),
    () => new Response('upstream secret', { status: 500 }),
    () => Response.json({ ...tokenResponse, expires_in: 0 }),
    () => Response.json({ ...tokenResponse, expires_in: '120' }),
    () => Response.json({ ...tokenResponse, resource: 'https://other.test' }),
    () => Response.json({ ...tokenResponse, token_type: 'MAC' }),
    () => Response.json({ ...tokenResponse, refresh_token: 'broader-token' }),
    () => Response.json({ ...tokenResponse, scope: '' }),
    () => Response.json({ ...tokenResponse, access_token: '' }),
  ];
  for (const reply of replies) {
    const response = await forwardEnterpriseGrant(request(), body, { endpoint, resource, fetchToken: async () => reply() });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(JSON.parse(response.body!), { error: 'server_error' });
  }
  const response = await forwardEnterpriseGrant(request(), body, { endpoint, resource, fetchToken: async () => { throw new TypeError('secret URL'); } });
  assert.equal(response.statusCode, 502);
  assert.ok(!response.body!.includes('secret'));
});
