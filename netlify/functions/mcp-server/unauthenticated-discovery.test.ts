// Drives the REAL handler (netlify/functions/mcp.ts): OpenAI and Codex clients
// may start a session and list tools without a token, and nothing else gets
// past the auth check without one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.OAUTH_ISSUER = 'https://mcp.example.com';
process.env.JWE_SECRET = 'test-only-auth-jwe-secret-at-least-32-chars';
process.env.EVENTS_RELAY_JWE_SECRET = 'test-only-events-relay-secret-at-least-32-chars';

const mcp = (await import('../mcp.ts')).default;

const origLog = console.log;
before(() => { console.log = () => {}; });
after(() => { console.log = origLog; });

const OPENAI_UA = 'openai-mcp/1.0.0';
const CODEX_UA = 'codex-mcp-client/0.162.0-alpha.17.2';
const ALLOWED_UAS = [OPENAI_UA, 'openai-mcp/1.0.0 (Codex)', CODEX_UA];

// Every method that may skip sign-in, with a valid message for each.
const DISCOVERY_MESSAGES = [
  { method: 'initialize', id: 1, params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } } },
  { method: 'notifications/initialized' },
  { method: 'server/discover', id: 1, params: {} },
  { method: 'ping', id: 1 },
  { method: 'tools/list', id: 1, params: {} },
];

function post(message: object, headers: Record<string, string>) {
  return mcp(new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...message }),
  }), {} as any);
}

async function toolNames(userAgent: string) {
  const response = await post({ method: 'tools/list', id: 1, params: {} }, { 'user-agent': userAgent });
  assert.equal(response.status, 200, `${userAgent} should get the tool list`);
  const text = await response.text();
  const framed = text.match(/^event: message\ndata: (.*)$/m);
  return (JSON.parse(framed ? framed[1] : text).result.tools as any[]).map(t => t.name);
}

test('OpenAI and Codex clients skip sign-in for every discovery method', async () => {
  for (const ua of ALLOWED_UAS) {
    for (const message of DISCOVERY_MESSAGES) {
      const response = await post(message, { 'user-agent': ua });
      assert.notEqual(response.status, 401, `${ua} ${message.method} should not need sign-in`);
      assert.ok(response.status < 500, `${ua} ${message.method} failed with ${response.status}`);
    }
  }
});

test('Codex gets the grouped tools and openai-mcp the granular ones, without a token', async () => {
  const codex = await toolNames(CODEX_UA);
  assert.ok(codex.includes('netlify-project-services-updater'), 'Codex should get the grouped selector tool');
  assert.equal(codex.includes('netlify-project-manage-env-vars'), false, 'Codex should not get per-operation tools');

  const openai = await toolNames(OPENAI_UA);
  assert.ok(openai.includes('netlify-project-manage-env-vars'), 'openai-mcp should get per-operation tools');
  assert.equal(openai.includes('netlify-project-services-updater'), false, 'openai-mcp should not get the grouped tool');
});

test('OpenAI and Codex clients still need a token for everything else', async () => {
  const gated = [
    { method: 'tools/call', id: 1, params: { name: 'netlify-user-services-reader', arguments: {} } },
    { method: 'resources/list', id: 1, params: {} },
    { method: 'prompts/list', id: 1, params: {} },
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

test('an invalid token does not block the tool list, but still blocks a tool call', async () => {
  for (const ua of ALLOWED_UAS) {
    const headers = { 'user-agent': ua, Authorization: 'Bearer not-a-real-token' };
    const list = await post({ method: 'tools/list', id: 1, params: {} }, headers);
    assert.equal(list.status, 200, `${ua} should get the tool list despite a bad token`);

    const call = await post(
      { method: 'tools/call', id: 1, params: { name: 'netlify-user-services-reader', arguments: {} } },
      headers,
    );
    assert.equal(call.status, 401, `${ua} tool call with a bad token should be rejected`);
    assert.match(call.headers.get('WWW-Authenticate') ?? '', /error="invalid_token"/);
  }
});

test('every other client still needs a token to list tools', async () => {
  for (const ua of ['Claude-User', 'claude-code/2.1.0 (cli)', 'cursor/1.0', 'some-proxy/1.0 codex-mcp-client', '']) {
    const response = await post({ method: 'tools/list', id: 1, params: {} }, ua ? { 'user-agent': ua } : {});
    assert.equal(response.status, 401, `${ua || 'no user agent'} should be rejected`);
  }
});
