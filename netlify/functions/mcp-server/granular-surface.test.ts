// Drives the REAL handler (netlify/functions/mcp.ts) so the wiring is covered,
// not just the pieces. src/tools/granular-tools.test.ts imports the tool
// definitions directly and checks isOpenAIMCPClient in isolation — which means
// deleting `|| openAIClient` from mcp.ts, or the `tool.description ??`
// preference in registerDomainTools, would leave it entirely green. These tests
// fail in both cases.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.OAUTH_ISSUER = 'https://mcp.example.com';
process.env.JWE_SECRET = 'test-only-auth-jwe-secret-at-least-32-chars';
process.env.EVENTS_RELAY_JWE_SECRET = 'test-only-events-relay-secret-at-least-32-chars';

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  const url = String(input?.url ?? input);
  if (url.includes('/api/v1/user')) {
    return new Response(JSON.stringify({ id: 'u1' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

const mcp = (await import('../mcp.ts')).default;

const origLog = console.log;
before(() => { console.log = () => {}; });
after(() => { console.log = origLog; globalThis.fetch = realFetch; });

async function toolsList(userAgent?: string, url = 'https://mcp.example.com/mcp') {
  const response = await mcp(new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer nfp_token_for_tests',
      'mcp-protocol-version': '2025-11-25',
      ...(userAgent ? { 'user-agent': userAgent } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  }), {} as any);
  const text = await response.text();
  const framed = text.match(/^event: message\ndata: (.*)$/m);
  return JSON.parse(framed ? framed[1] : text).result.tools as any[];
}

const GROUPED = 'netlify-project-services-updater';
const GRANULAR = 'netlify-project-manage-env-vars';

test('an openai-mcp user agent gets the granular surface end to end', async () => {
  const names = (await toolsList('openai-mcp/1.0.0')).map(t => t.name);
  assert.ok(names.includes(GRANULAR), 'expected one tool per operation');
  assert.equal(names.includes(GROUPED), false, 'expected no grouped selector tool');
});

test('every other client still gets the grouped surface', async () => {
  const names = (await toolsList('some-other-client/2.0')).map(t => t.name);
  assert.ok(names.includes(GROUPED), 'expected the grouped selector tool');
  assert.equal(names.includes(GRANULAR), false, 'expected no per-operation tools');
  // And a request with no user-agent at all must not trip the granular path.
  const anon = (await toolsList()).map(t => t.name);
  assert.ok(anon.includes(GROUPED));
});

test('?verbose=true still opts in for a non-openai client', async () => {
  const names = (await toolsList('some-other-client/2.0', 'https://mcp.example.com/mcp?verbose=true'))
    .map(t => t.name);
  assert.ok(names.includes(GRANULAR), 'the manual opt-in must keep working');
});

test('granular tools carry their own description, not the generated stub', async () => {
  // Guards the `tool.description ??` preference in registerDomainTools.
  const tools = await toolsList('openai-mcp/1.0.0');
  for (const tool of tools) {
    assert.ok(tool.description, `${tool.name} has no description`);
    assert.equal(
      /^[a-z-]+ operation for Netlify /.test(tool.description), false,
      `${tool.name} fell back to the generated stub: "${tool.description}"`,
    );
  }
});

test('granular tools carry explicit behaviour hints', async () => {
  const tools = await toolsList('openai-mcp/1.0.0');
  for (const tool of tools) {
    for (const key of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
      assert.equal(
        typeof tool.annotations?.[key], 'boolean',
        `${tool.name} is missing a boolean ${key}`,
      );
    }
  }
  // The three real deletes, and nothing else, warn about destruction.
  const destructive = tools.filter(t => t.annotations.destructiveHint).map(t => t.name).sort();
  assert.deepEqual(destructive, [
    'netlify-extension-change-extension-installation',
    'netlify-project-manage-env-vars',
    'netlify-project-manage-form-submissions',
  ]);
});
