// End-to-end through the REAL function handler (netlify/functions/mcp.ts): the
// coding-context tool as a client sees it, backed by a synthetic hosted-skills
// manifest. Covers both protocol eras because they frame requests differently.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.OAUTH_ISSUER = 'https://mcp.example.com';
process.env.JWE_SECRET = 'test-only-auth-jwe-secret-at-least-32-chars';
process.env.EVENTS_RELAY_JWE_SECRET = 'test-only-events-relay-secret-at-least-32-chars';

const { SKILLS_HOST, resetCodingContextCachesForTests } = await import('../../../src/context/coding-context.ts');

const VERSION = 'v-test-1';
const FILES: Record<string, string> = {
  'netlify-database/SKILL.md': '# Netlify Database\n\nUse migrations.\n',
  'netlify-database/references/migrations.md': '# Migrations\n\nTimestamped files only.\n',
  'netlify-functions/SKILL.md': '# Netlify Functions\n\nExport a default handler.\n',
};
const sha = (body: string) => `sha256:${createHash('sha256').update(body).digest('hex')}`;

const MANIFEST = {
  schema_version: 1,
  version: VERSION,
  skills: [
    {
      name: 'netlify-database', status: 'active', prior_names: [], description: 'DB',
      files: {
        'SKILL.md': sha(FILES['netlify-database/SKILL.md']),
        'references/migrations.md': sha(FILES['netlify-database/references/migrations.md']),
      },
    },
    {
      name: 'netlify-functions', status: 'active', prior_names: [], description: 'Functions',
      files: { 'SKILL.md': sha(FILES['netlify-functions/SKILL.md']) },
    },
  ],
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any) => {
  const url = String(input?.url ?? input);
  if (url.includes('/api/v1/user')) {
    return new Response(JSON.stringify({ id: 'user-1' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  if (url === `${SKILLS_HOST}/manifest.json`) {
    return new Response(JSON.stringify(MANIFEST), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  const prefix = `${SKILLS_HOST}/v/${VERSION}/skills/`;
  if (url.startsWith(prefix) && url.slice(prefix.length) in FILES) {
    return new Response(FILES[url.slice(prefix.length)], { status: 200 });
  }
  return new Response('not found', { status: 404 });
}) as typeof fetch;

const mcp = (await import('../mcp.ts')).default;

const origLog = console.log;
before(() => { console.log = () => {}; });
after(() => { console.log = origLog; globalThis.fetch = realFetch; });
beforeEach(() => resetCodingContextCachesForTests());

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

async function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await mcp(new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer nfp_token_for_tests',
      ...headers,
    },
    body: JSON.stringify(body),
  }), {} as any);

  const text = await response.text();
  const framed = text.match(/^event: message\ndata: (.*)$/m);
  return { status: response.status, body: JSON.parse(framed ? framed[1] : text) };
}

const TOOL = 'get-netlify-coding-context';

type Era = { name: string; call: (id: number, method: string, params: Record<string, unknown>) => ReturnType<typeof post> };
const eras: Era[] = [
  {
    name: 'legacy era',
    call: (id, method, params) => post(
      { jsonrpc: '2.0', id, method, params },
      { 'mcp-protocol-version': '2025-11-25' },
    ),
  },
  {
    name: 'modern era',
    call: (id, method, params) => post(
      { jsonrpc: '2.0', id, method, params: { ...params, _meta: MODERN_META } },
      {
        'mcp-protocol-version': '2026-07-28',
        'Mcp-Method': method,
        ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
      },
    ),
  },
];

for (const era of eras) {
  test(`${era.name}: tools/list exposes the coding-context tool with skill topics`, async () => {
    const { status, body } = await era.call(1, 'tools/list', {});
    assert.equal(status, 200);
    const tool = body.result.tools.find((t: any) => t.name === TOOL);
    assert.ok(tool, `${TOOL} must be listed`);
    const { creationType, reference } = tool.inputSchema.properties;
    assert.ok(creationType.enum.includes('netlify-database'));
    assert.ok(creationType.enum.includes('serverless'), 'legacy topic names stay callable');
    assert.equal(reference.type, 'string');
    assert.ok(!(tool.inputSchema.required ?? []).includes('reference'));
  });

  test(`${era.name}: a legacy topic returns the skill body plus the reference note`, async () => {
    const { body } = await era.call(2, 'tools/call', { name: TOOL, arguments: { creationType: 'db' } });
    assert.notEqual(body.result.isError, true);
    const text: string = body.result.content[0].text;
    assert.ok(text.startsWith(FILES['netlify-database/SKILL.md']));
    assert.match(text, /- references\/migrations\.md/);
  });

  test(`${era.name}: a reference path returns exactly that file`, async () => {
    const { body } = await era.call(3, 'tools/call', {
      name: TOOL,
      arguments: { creationType: 'netlify-database', reference: 'references/migrations.md' },
    });
    assert.notEqual(body.result.isError, true);
    assert.equal(body.result.content[0].text, FILES['netlify-database/references/migrations.md']);
  });

  test(`${era.name}: an unknown reference is an error`, async () => {
    const { body } = await era.call(4, 'tools/call', {
      name: TOOL,
      arguments: { creationType: 'netlify-database', reference: 'references/nope.md' },
    });
    assert.equal(body.result.isError, true);
  });
}
