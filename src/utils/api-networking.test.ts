import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

// Expired or undecryptable bearers must surface as auth failures (401 /
// invalid_token) so clients refresh — never as a 500 from an uncaught throw.

process.env.OAUTH_ISSUER = 'https://netlify-mcp.netlify.app';
process.env.JWE_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

const requestWithBearer = (bearer: string) =>
  new Request('https://netlify-mcp.netlify.app/mcp', {
    headers: { Authorization: `Bearer ${bearer}` },
  });

test('an expired JWE bearer is an auth failure, not a thrown server error', async () => {
  const { getNetlifyAccessToken, userIsAuthenticated, NetlifyUnauthError } = await import('./api-networking.ts');
  const { createJWE } = await import('../../netlify/functions/mcp-server/utils.ts');

  const expired = await createJWE({ accessToken: 'nfp_test' }, '1s');
  await sleep(1500);

  await assert.rejects(getNetlifyAccessToken(requestWithBearer(expired)), NetlifyUnauthError);
  assert.equal(await userIsAuthenticated(requestWithBearer(expired)), false);
});

test('an undecryptable bearer is an auth failure, not a thrown server error', async () => {
  const { getNetlifyAccessToken, userIsAuthenticated, NetlifyUnauthError } = await import('./api-networking.ts');

  await assert.rejects(getNetlifyAccessToken(requestWithBearer('not-a-jwe')), NetlifyUnauthError);
  assert.equal(await userIsAuthenticated(requestWithBearer('not-a-jwe')), false);
});

test('the deploy proxy returns 401 (not a crash) for an expired token', async () => {
  const { handleProxy } = await import('../../netlify/edge-functions/proxy.ts');
  const { createJWE } = await import('../../netlify/functions/mcp-server/utils.ts');

  const expired = await createJWE({ accessToken: 'nfp_test' }, '1s');
  await sleep(1500);

  const resp = await handleProxy(
    new Request(`https://netlify-mcp.netlify.app/proxy/${expired}/api/v1/deploys/x`, { method: 'GET' }),
    expired,
  );
  assert.equal(resp.status, 401);
});
