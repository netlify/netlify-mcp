import { test } from 'node:test';
import assert from 'node:assert/strict';

const testRequest = () =>
  new Request('https://netlify-mcp.netlify.app/mcp', {
    headers: { Authorization: 'Bearer nfp_test_token' },
  });

test('update-project-name reports a 422 name conflict as an error with a clear message', async (t) => {
  const { updateProjectNameDomainTool } = await import('./update-project-name.ts');

  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ message: 'name must be unique' }), { status: 422 }),
  );

  // regression: the conflict must not be fed into getEnrichedSiteModelForLLM,
  // which would silently discard this message and return `[{}]`-shaped JSON instead.
  await assert.rejects(
    updateProjectNameDomainTool.cb({ siteId: 'site-1', name: 'taken-name' }, { request: testRequest() }),
    /taken-name.*already taken/,
  );
});

test('update-project-name succeeds and returns the enriched site on a free name', async (t) => {
  const { updateProjectNameDomainTool } = await import('./update-project-name.ts');

  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ id: 'site-1', name: 'new-name', account_id: 'acct-1' }), { status: 200 }),
  );

  const result = await updateProjectNameDomainTool.cb({ siteId: 'site-1', name: 'new-name' }, { request: testRequest() });

  const parsed = JSON.parse(result);
  assert.equal(parsed[0].name, 'new-name');
});
