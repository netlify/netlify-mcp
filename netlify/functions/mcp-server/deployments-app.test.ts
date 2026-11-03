import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/server';

process.env.OAUTH_ISSUER = 'https://mcp.example.com';
process.env.JWE_SECRET = 'test-only-auth-jwe-secret-at-least-32-chars';
process.env.EVENTS_RELAY_JWE_SECRET = 'test-only-events-relay-secret-at-least-32-chars';

const siteId = '11111111-1111-4111-8111-111111111111';
const deploy = {
  id: 'deploy-1', site_id: siteId, name: 'my-project', state: 'building',
  branch: 'main', context: 'production', commit_ref: 'abc1234',
  commit_url: 'https://github.com/example/project/commit/abc1234',
  deploy_ssl_url: 'https://main--my-project.netlify.app',
  ssl_url: 'https://my-project.netlify.app',
  file_configuration: { secret: 'do-not-send' }, skew_protection_token: 'do-not-send',
};
let deploys: object[];
let apiStatus: number;
let siteStatus: number;
let apiCalls: string[];
const realFetch = globalThis.fetch;
const realLog = console.log;
console.log = () => {};
globalThis.fetch = (async (input: any, init: RequestInit) => {
  const url = new URL(String(input?.url ?? input));
  if (url.href === 'https://www.netlify.com/context-files/manifest.json') {
    return Response.json({ schema_version: 1, version: 'test', skills: [{
      name: 'netlify-functions', status: 'active', prior_names: [], description: 'Functions',
      files: { 'SKILL.md': 'sha256:' + 'a'.repeat(64) },
    }] });
  }
  assert.equal(url.origin, 'https://api.netlify.com');
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer nfp_test');
  if (url.pathname === '/api/v1/user') return Response.json({ id: 'user-1' });
  apiCalls.push(url.pathname + url.search);
  if (apiStatus !== 200) return Response.json({ message: 'Denied' }, { status: apiStatus });
  if (url.pathname === `/api/v1/sites/${siteId}`) {
    if (siteStatus !== 200) return Response.json({ message: 'Unavailable' }, { status: siteStatus });
    return Response.json({ name: 'my-project', account_name: 'Example team', account_slug: 'example-team', secret: 'do-not-send' });
  }
  if (url.pathname.endsWith('/deploys')) return Response.json(deploys);
  assert.equal(url.pathname, `/api/v1/sites/${siteId}/deploys/deploy-1`);
  return Response.json(deploys[0]);
}) as typeof fetch;
const mcp = (await import('../mcp.ts')).default;
after(() => { globalThis.fetch = realFetch; console.log = realLog; });
beforeEach(() => { deploys = [{ ...deploy }]; apiStatus = siteStatus = 200; apiCalls = []; });

async function rpc(method: string, params: Record<string, unknown>, modern = false, authenticated = true) {
  const response = await mcp(new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'user-agent': 'openai-mcp/1.0.0',
      ...(authenticated ? { Authorization: 'Bearer nfp_test' } : {}),
      'mcp-protocol-version': modern ? '2026-07-28' : '2025-11-25',
      ...(modern ? { 'Mcp-Method': method } : {}),
      ...(modern && (params.name || params.uri) ? { 'Mcp-Name': String(params.name || params.uri) } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {
      ...params,
      ...(modern ? { _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } : {}),
    } }),
  }), {} as any);
  const text = await response.text();
  const framed = text.match(/^event: message\ndata: (.*)$/m);
  return { status: response.status, body: JSON.parse(framed ? framed[1] : text) };
}

for (const modern of [false, true]) {
  test(`deployment app discovery, resource and reads work through ${modern ? 'modern' : 'legacy'} MCP`, async () => {
    const { body: listed } = await rpc('tools/list', {}, modern);
    const open = listed.result.tools.find((tool: any) => tool.name === 'netlify-open-deployments');
    assert.equal(open.annotations.readOnlyHint, true);
    const uri = open._meta.ui.resourceUri;
    const refresh = listed.result.tools.find((tool: any) => tool.name === 'netlify-refresh-deployments');
    assert.deepEqual(refresh._meta.ui.visibility, ['app']);
    assert.equal(refresh._meta.ui.resourceUri, undefined, 'refresh must not mount another card');

    const { body: resource } = await rpc('resources/read', { uri }, modern);
    assert.ok(resource.result, JSON.stringify(resource));
    assert.equal(resource.result.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.match(resource.result.contents[0].text, /ui\/initialize/);
    assert.equal(apiCalls.length, 0, 'the static UI must not read project data');

    const { body } = await rpc('tools/call', { name: open.name, arguments: { siteId } }, modern);
    assert.equal(body.result.isError, undefined);
    assert.equal(body.result.structuredContent.hasActiveDeploys, true);
    assert.equal(body.result.structuredContent.deploys[0].deployUrl, null);
    assert.match(body.result.content[0].text, /building.*deploy-1/);
    assert.match(body.result.content[0].text, /main · production/);
    assert.doesNotMatch(JSON.stringify(body.result), /do-not-send|file_configuration|skew_protection_token/);
    assert.deepEqual(apiCalls, [`/api/v1/sites/${siteId}/deploys?per_page=5`, `/api/v1/sites/${siteId}`]);

    assert.deepEqual(body.result.structuredContent.project, { name: 'my-project', teamName: 'Example team', teamUrl: 'https://app.netlify.com/teams/example-team/overview' });
    assert.equal(body.result.structuredContent.deploys[0].commit, undefined);
    assert.equal(body.result.structuredContent.deploys[0].commitUrl, undefined);
    apiCalls = [];
    deploys = [{ ...deploy, state: 'ready' }];
    const { body: updated } = await rpc('tools/call', {
      name: refresh.name, arguments: { siteId, deployId: 'deploy-1' },
    }, modern);
    assert.equal(updated.result.structuredContent.hasActiveDeploys, false);
    assert.equal(updated.result.structuredContent.deploys[0].deployUrl, 'https://deploy-1--my-project.netlify.app/');
    assert.deepEqual(apiCalls, [`/api/v1/sites/${siteId}/deploys/deploy-1`], 'polling must not re-fetch team context');
  });
}

test('empty lists, failures and skipped builds are finite; unsafe links are omitted', async () => {
  for (const records of [[], [{ ...deploy, state: 'error', error_message: 'Build failed' }],
    [{ ...deploy, state: 'ready', skipped: true }], [{ ...deploy, state: 'ready', name: 'bad/name', commit_url: 'data:text/html,hi' }]]) {
    deploys = records;
    const { body } = await rpc('tools/call', { name: 'netlify-open-deployments', arguments: { siteId } });
    assert.equal(body.result.structuredContent.hasActiveDeploys, false);
    assert.equal(body.result.structuredContent.deploys[0]?.deployUrl ?? null, null);
    assert.doesNotMatch(JSON.stringify(body.result), /javascript:|data:text/);
    if (!records.length) assert.match(body.result.content[0].text, /No deploys/);
  }
});

test('processed and pending-review deployments keep polling; terminal states stop', async () => {
  for (const state of ['processed', 'pending_review', 'ready', 'error', 'rejected']) {
    deploys = [{ ...deploy, state }];
    const { body } = await rpc('tools/call', { name: 'netlify-refresh-deployments', arguments: { siteId } });
    assert.equal(body.result.structuredContent.hasActiveDeploys, ['processed', 'pending_review'].includes(state), state);
  }
});

test('optional project lookup failures do not hide successfully loaded deployments', async () => {
  for (siteStatus of [403, 500]) {
    const { body } = await rpc('tools/call', { name: 'netlify-open-deployments', arguments: { siteId } });
    assert.equal(body.result.isError, undefined);
    assert.equal(body.result.structuredContent.deploys[0].id, deploy.id);
    assert.equal(body.result.structuredContent.hasActiveDeploys, true);
    assert.equal(body.result.structuredContent.project, undefined);
  }
});

test('deployment registration failure leaves coding-context and domain tools available', async t => {
  const original = McpServer.prototype.registerResource;
  t.mock.method(McpServer.prototype, 'registerResource', function (this: McpServer, ...args: Parameters<typeof original>) {
    if (args[0] === 'netlify-deployments') throw new Error('test registration failure');
    return original.apply(this, args);
  });
  const { body } = await rpc('tools/list', {});
  const names = body.result.tools.map((tool: any) => tool.name);
  assert.ok(names.includes('get-netlify-coding-context'));
  assert.ok(names.includes('netlify-project-get-projects'));
  assert.ok(!names.includes('netlify-open-deployments'));
});

test('both tools enforce auth, input validation and upstream access errors', async () => {
  for (const name of ['netlify-open-deployments', 'netlify-refresh-deployments']) {
    assert.equal((await rpc('tools/call', { name, arguments: { siteId } }, false, false)).status, 401);
    for (const args of [{ siteId: '../other' }, { siteId, deployId: '../other' }]) {
      const { body } = await rpc('tools/call', { name, arguments: args });
      assert.ok(body.error || body.result?.isError);
    }
    assert.equal(apiCalls.length, 0);
    apiStatus = 403;
    const { body } = await rpc('tools/call', { name, arguments: { siteId } });
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /403/);
    apiCalls = [];
  }
});


test('filters query the API before limiting results and reject invalid combinations', async () => {
  const filters = { status: 'error', from: 1000, to: 2000 };
  const { body } = await rpc('tools/call', { name: 'netlify-refresh-deployments', arguments: { siteId, ...filters } });
  assert.deepEqual(body.result.structuredContent.filters, filters);
  assert.deepEqual(apiCalls, [`/api/v1/sites/${siteId}/deploys?per_page=5&state=error&from=1000&to=2000`]);
  apiCalls = [];
  for (const args of [{ status: 'bogus' }, { from: 100 }, { to: 100 }, { from: 200, to: 100 }, { from: -1, to: 100 }, { deployId: 'deploy-1', status: 'ready' }]) {
    const { body: invalid } = await rpc('tools/call', { name: 'netlify-open-deployments', arguments: { siteId, ...args } });
    assert.ok(invalid.error || invalid.result?.isError);
  }
  assert.deepEqual(apiCalls, []);
});
