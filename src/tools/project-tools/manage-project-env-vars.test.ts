import { test } from 'node:test';
import assert from 'node:assert/strict';

const testRequest = () =>
  new Request('https://netlify-mcp.netlify.app/mcp', {
    headers: { Authorization: 'Bearer nfp_test_token' },
  });

// Stub the three calls an upsert of a new key makes: site lookup, existing-var
// lookup (404 = new key), then the create POST with the status under test.
const stubUpsert = (t: any, createStatus: number) =>
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/api/v1/sites/site-1')) {
      return new Response(JSON.stringify({ id: 'site-1', account_id: 'team-1' }), { status: 200 });
    }
    if (init?.method === 'POST') {
      return new Response(JSON.stringify({ code: createStatus, msg: 'nope' }), { status: createStatus });
    }
    return new Response('', { status: 404 });
  });

const upsert = async () => {
  const { manageEnvVarsDomainTool } = await import('./manage-project-env-vars.ts');
  return manageEnvVarsDomainTool.cb(
    { siteId: 'site-1', upsertEnvVar: true, envVarKey: 'API_KEY', envVarValue: 'v', newVarScopes: ['all'], newVarContext: 'all' } as any,
    { request: testRequest() },
  );
};

test('a rejected env var create is an error, not "upserted"', async (t) => {
  const { NetlifyApiError } = await import('../../utils/api-networking.ts');
  for (const status of [401, 403, 422]) {
    stubUpsert(t, status);
    const err = await upsert().then(() => null, (e: unknown) => e);
    assert.ok(err instanceof NetlifyApiError, `status ${status}: expected NetlifyApiError, got ${String(err)}`);
    assert.equal(err.status, status);
  }
});

test('a successful env var create still reports upserted', async (t) => {
  stubUpsert(t, 201);
  assert.equal(await upsert(), 'Environment variable upserted');
});
