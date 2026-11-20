// Drives the REAL handler (netlify/functions/mcp.ts): OpenAI and Codex clients
// may start a session and list tools without a token, and nothing else gets
// past the auth check without one.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.OAUTH_ISSUER = 'https://mcp.example.com';
process.env.JWE_SECRET = 'test-only-auth-jwe-secret-at-least-32-chars';
process.env.EVENTS_RELAY_JWE_SECRET = 'test-only-events-relay-secret-at-least-32-chars';

const mcp = (await import('../mcp.ts')).default;
const { createJWE } = await import('./utils.ts');

// Keep info lines so the log flag can be checked, instead of printing them.
const origLog = console.log;
let logged: string[] = [];
before(() => { console.log = (line: unknown) => { logged.push(String(line)); }; });
after(() => { console.log = origLog; });
beforeEach(() => { logged = []; });

function loggedEntries(message: string) {
  return logged
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line))
    .filter(entry => entry.message === message);
}

const OPENAI_UA = 'openai-mcp/1.0.0';
const OPENAI_CODEX_UA = 'openai-mcp/1.0.0 (Codex)';
const CODEX_UA = 'codex-mcp-client/0.162.0-alpha.17.2';
const ALLOWED_UAS = [OPENAI_UA, OPENAI_CODEX_UA, CODEX_UA];
const BAD_TOKEN = 'Bearer not-a-real-token';

const TOOLS_LIST = { method: 'tools/list', id: 1, params: {} };

// A 2026-07-28 request needs a per-request `_meta` envelope and an `Mcp-Method`
// header that agrees with the body, or the SDK rejects it before dispatch.
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
const modern = (method: string) => ({
  method,
  id: 1,
  params: { _meta: ENVELOPE },
  headers: { 'mcp-protocol-version': '2026-07-28', 'Mcp-Method': method },
});

// Every method that may skip sign-in, with a valid message for each.
const DISCOVERY_MESSAGES = [
  { method: 'initialize', id: 1, params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } } },
  { method: 'notifications/initialized' },
  { method: 'ping', id: 1 },
  TOOLS_LIST,
  modern('server/discover'),
  modern('tools/list'),
];

type Message = { method: string; id?: number; params?: object; headers?: Record<string, string> };

function post(message: Message, headers: Record<string, string>) {
  const { headers: messageHeaders, ...body } = message;
  return mcp(new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      ...messageHeaders,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...body }),
  }), {} as any);
}

// The JSON-RPC reply, whether it came back as plain JSON or one SSE event.
// Notifications get an empty body, so this returns undefined for them.
async function reply(response: Response) {
  const text = await response.text();
  if (!text.trim()) return undefined;
  const framed = text.match(/^event: message\ndata: (.*)$/m);
  return JSON.parse(framed ? framed[1] : text);
}

async function toolNames(userAgent: string) {
  const response = await post(TOOLS_LIST, { 'user-agent': userAgent });
  assert.equal(response.status, 200, `${userAgent} should get the tool list`);
  return ((await reply(response)).result.tools as any[]).map(t => t.name);
}

// Asserts the request worked: a 2xx and, for requests, a result with no error.
async function assertSucceeded(response: Response, message: { method: string; id?: number }, label: string) {
  assert.ok(response.ok, `${label} ${message.method} failed with ${response.status}`);
  const body = await reply(response);
  if (message.id === undefined) return;
  assert.equal(body?.error, undefined, `${label} ${message.method} returned ${JSON.stringify(body?.error)}`);
  assert.ok(body?.result, `${label} ${message.method} returned no result`);
}

test('OpenAI and Codex clients skip sign-in for every discovery method', async () => {
  for (const ua of ALLOWED_UAS) {
    for (const message of DISCOVERY_MESSAGES) {
      await assertSucceeded(await post(message, { 'user-agent': ua }), message, ua);
    }
  }
});

test('a bad token does not block any discovery method', async () => {
  for (const ua of ALLOWED_UAS) {
    for (const message of DISCOVERY_MESSAGES) {
      await assertSucceeded(await post(message, { 'user-agent': ua, Authorization: BAD_TOKEN }), message, `${ua} with a bad token`);
    }
  }
});

test('Codex gets the grouped tools and openai-mcp the granular ones, without a token', async () => {
  const codex = await toolNames(CODEX_UA);
  assert.ok(codex.includes('netlify-project-services-updater'), 'Codex should get the grouped selector tool');
  assert.equal(codex.includes('netlify-project-manage-env-vars'), false, 'Codex should not get per-operation tools');

  for (const ua of [OPENAI_UA, OPENAI_CODEX_UA]) {
    const openai = await toolNames(ua);
    assert.ok(openai.includes('netlify-project-manage-env-vars'), `${ua} should get per-operation tools`);
    assert.equal(openai.includes('netlify-project-services-updater'), false, `${ua} should not get the grouped tool`);
  }
});

test('OpenAI and Codex clients still need a token for everything else', async () => {
  const gated = [
    { method: 'tools/call', id: 1, params: { name: 'netlify-user-services-reader', arguments: {} } },
    { method: 'resources/list', id: 1, params: {} },
    { method: 'resources/read', id: 1, params: { uri: 'file:///x' } },
    { method: 'prompts/list', id: 1, params: {} },
    { method: 'prompts/get', id: 1, params: { name: 'x' } },
    { method: 'completion/complete', id: 1, params: {} },
    { method: 'logging/setLevel', id: 1, params: { level: 'info' } },
    { method: 'events/list', id: 1, params: {} },
  ];
  for (const ua of ALLOWED_UAS) {
    for (const message of gated) {
      const response = await post(message, { 'user-agent': ua });
      assert.equal(response.status, 401, `${ua} ${message.method} should need sign-in`);
      assert.match(response.headers.get('WWW-Authenticate') ?? '', /resource_metadata=/);
    }
  }
});

test('a bad token is rejected on a tool call, so the client refreshes it there', async () => {
  for (const ua of ALLOWED_UAS) {
    const response = await post(
      { method: 'tools/call', id: 1, params: { name: 'netlify-user-services-reader', arguments: {} } },
      { 'user-agent': ua, Authorization: BAD_TOKEN },
    );
    assert.equal(response.status, 401, `${ua} tool call with a bad token should be rejected`);
    assert.match(response.headers.get('WWW-Authenticate') ?? '', /error="invalid_token"/);
  }
});

test('only signed-out tool lists are flagged in the logs', async () => {
  await post(TOOLS_LIST, { 'user-agent': CODEX_UA });
  const [signedOut] = loggedEntries('tools list requested');
  assert.equal(signedOut?.unauthenticatedDiscovery, true, 'a signed-out tool list should be flagged');
  assert.equal(signedOut?.userId, undefined);

  logged = [];
  const token = await createJWE({ accessToken: 'nfp_test_token', identity: { userId: 'u1', teamId: 't1' } }, '1h');
  await post(TOOLS_LIST, { 'user-agent': CODEX_UA, Authorization: `Bearer ${token}` });
  const [signedIn] = loggedEntries('tools list requested');
  assert.equal(signedIn?.userId, 'u1', 'a signed-in tool list should carry the user');
  assert.equal(signedIn?.unauthenticatedDiscovery, undefined, 'a signed-in tool list should not be flagged');
});

test('every other client still needs a token to list tools', async () => {
  for (const ua of ['Claude-User', 'claude-code/2.1.0 (cli)', 'cursor/1.0', 'some-proxy/1.0 codex-mcp-client', 'some-proxy/1.0 openai-mcp/1.0.0', '']) {
    const response = await post(TOOLS_LIST, ua ? { 'user-agent': ua } : {});
    assert.equal(response.status, 401, `${ua || 'no user agent'} should be rejected`);
  }
});
