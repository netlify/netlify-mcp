import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.OAUTH_ISSUER = 'https://mcp.example.com';
process.env.JWE_SECRET = 'test-only-write-failures-secret-at-least-32-chars';

const mcp = (await import('../mcp.ts')).default;

beforeEach(() => {
  for (const method of ['log', 'warn', 'error'] as const) {
    mock.method(console, method, () => {});
  }
});
afterEach(() => mock.restoreAll());

type Surface = 'grouped' | 'granular';

async function callTool(surface: Surface, operation: string, params: Record<string, unknown>) {
  const response = await mcp(
    new Request('https://mcp.example.com/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer nfp_write_failures_test',
        'mcp-protocol-version': '2025-11-25',
        'user-agent': surface === 'granular' ? 'openai-mcp/1.0.0' : 'test-client',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: surface === 'granular' ? `netlify-project-${operation}` : 'netlify-project-services-updater',
          arguments: surface === 'granular' ? params : { selectSchema: { operation, params } },
        },
      }),
    }),
    {} as any,
  );
  const text = await response.text();
  const framed = text.match(/^event: message\ndata: (.*)$/m);
  return JSON.parse(framed ? framed[1] : text).result;
}

const respondWith = (status: number, body: string) =>
  mock.method(globalThis, 'fetch', async () => new Response(body, { status }));

const failures = [
  {
    name: 'create-new-project on a 500',
    operation: 'create-new-project',
    params: { name: 'my-site' },
    status: 500,
    text: /Failed to create project: 500/,
  },
  {
    name: 'create-new-project after repeated name conflicts',
    operation: 'create-new-project',
    params: { name: 'always-taken' },
    status: 422,
    text: /always-taken.*already taken/,
  },
  {
    name: 'create-new-project with no name to retry',
    operation: 'create-new-project',
    params: {},
    status: 422,
    text: /couldn't generate a unique project name/,
  },
  {
    name: 'update-project-name on a 500',
    operation: 'update-project-name',
    params: { siteId: 'site-1', name: 'new-name' },
    status: 500,
    text: /Failed to update project name: 500/,
  },
  {
    name: 'update-project-name on a name conflict',
    operation: 'update-project-name',
    params: { siteId: 'site-1', name: 'taken-name' },
    status: 422,
    text: /taken-name.*already taken/,
  },
];

for (const surface of ['grouped', 'granular'] as const) {
  for (const { name, operation, params, status, text } of failures) {
    test(`${surface}: ${name} is an error result that keeps its message`, async () => {
      respondWith(status, JSON.stringify({ message: 'nope' }));

      const result = await callTool(surface, operation, params);

      assert.equal(result.isError, true, JSON.stringify(result));
      assert.match(result.content[0].text, text);
    });
  }

  test(`${surface}: a successful create is not an error result`, async () => {
    respondWith(200, JSON.stringify({ id: 'site-1', name: 'my-site', account_id: 'team-one' }));

    const result = await callTool(surface, 'create-new-project', { name: 'my-site' });

    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.match(result.content[0].text, /my-site/);
  });

  test(`${surface}: a successful rename is not an error result`, async () => {
    respondWith(200, JSON.stringify({ id: 'site-1', name: 'new-name', account_id: 'team-one' }));

    const result = await callTool(surface, 'update-project-name', { siteId: 'site-1', name: 'new-name' });

    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.match(result.content[0].text, /new-name/);
  });
}
