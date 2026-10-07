import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

process.env.OAUTH_ISSUER = 'https://netlify-mcp.netlify.app';
process.env.JWE_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

const requestWithBearer = (bearer: string) =>
  new Request('https://netlify-mcp.netlify.app/mcp', {
    headers: { Authorization: `Bearer ${bearer}` },
  });

test('an expired JWE bearer is an auth failure, not a thrown server error', async () => {
  const { getNetlifyAccessToken, userIsAuthenticated, NetlifyUnauthError } = await import('./api-networking.ts');
  const { createJWE } = await import('../../netlify/functions/mcp-server/utils.ts');

  // Typed, so the only thing wrong with it is its age: an untyped token is
  // refused for its missing token_use whether or not it has expired.
  const expired = await createJWE({ token_use: 'access', accessToken: 'nfp_test' }, '1s');
  assert.equal(await getNetlifyAccessToken(requestWithBearer(expired)), 'nfp_test');
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

  const apisAllowed = [{ path: '/api/v1/deploys/:deploy_id', method: 'GET' }];
  const expired = await createJWE({ token_use: 'proxy', accessToken: 'nfp_test', apisAllowed }, '1s');
  await sleep(1500);

  const resp = await handleProxy(
    new Request(`https://netlify-mcp.netlify.app/proxy/${expired}/api/v1/deploys/x`, { method: 'GET' }),
    expired,
  );
  assert.equal(resp.status, 401);
});
