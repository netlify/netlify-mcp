import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleProxy } from './proxy.ts';
import { createJWE } from '../functions/mcp-server/utils.ts';

// createJWE/decryptJWE round-trip on the localhost dev key when JWE_SECRET and
// OAUTH_ISSUER are unset (the test environment), so no secret setup is needed.
async function tokenFor(apisAllowed: Array<{ path: string; method: string }>): Promise<string> {
  return createJWE({ accessToken: 'nfp_test_token', apisAllowed }, '1h');
}

const allow = [{ path: '/api/v1/sites/:id/builds', method: 'POST' }];

test('handleProxy blocks a protocol-relative host override (SSRF + token leak)', async () => {
  const token = await tokenFor(allow);
  // `//attacker.example/...` after the token makes `new URL(path, base)` drop the
  // base and resolve to attacker.example, while the pathname still matches.
  const req = new Request(
    `https://mcp.example/proxy/${token}//attacker.example/api/v1/sites/abc/builds`,
    { method: 'POST' },
  );
  const res = await handleProxy(req, token);
  assert.equal(res.status, 403);
});

test('handleProxy blocks an absolute-url host override (SSRF + token leak)', async () => {
  const token = await tokenFor(allow);
  const req = new Request(
    `https://mcp.example/proxy/${token}https://attacker.example/api/v1/sites/abc/builds`,
    { method: 'POST' },
  );
  const res = await handleProxy(req, token);
  assert.equal(res.status, 403);
});

test('handleProxy forwards an allowed path to the Netlify API only', async () => {
  const token = await tokenFor(allow);
  const originalFetch = globalThis.fetch;
  let forwardedUrl: string | undefined;
  globalThis.fetch = (async (input: any) => {
    forwardedUrl = typeof input === 'string' ? input : input.url;
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  try {
    const req = new Request(
      `https://mcp.example/proxy/${token}/api/v1/sites/abc/builds`,
      { method: 'POST' },
    );
    const res = await handleProxy(req, token);
    assert.equal(res.status, 200);
    assert.ok(
      forwardedUrl?.startsWith('https://api.netlify.com/api/v1/sites/abc/builds'),
      `expected forward to api.netlify.com, got ${forwardedUrl}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
