import { test } from 'node:test';
import assert from 'node:assert/strict';

test('remote deploy-site builds a proxy URL with no double slash', async () => {
  // A bare-origin issuer is what production uses; getOAuthIssuer()
  // canonicalizes it to include a trailing slash, and the proxy URL
  // construction must tolerate that.
  process.env.OAUTH_ISSUER = 'https://netlify-mcp.netlify.app';
  process.env.JWE_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

  // Import after the env is set so module state picks up the test values.
  const { deploySiteRemotelyDomainTool } = await import('./deploy-site.ts');

  const request = new Request('https://netlify-mcp.netlify.app/mcp', {
    headers: { Authorization: 'Bearer nfp_test_token' },
  });
  const result = await deploySiteRemotelyDomainTool.cb({ siteId: 'site-123' }, { request });

  const proxyUrl = /--proxy-path "([^"]+)"/.exec(result)?.[1];
  assert.ok(proxyUrl, `no --proxy-path in tool output: ${result}`);
  assert.ok(
    proxyUrl.startsWith('https://netlify-mcp.netlify.app/proxy/'),
    `proxy URL must hit the /proxy/:token/* route, got: ${proxyUrl}`,
  );
});
