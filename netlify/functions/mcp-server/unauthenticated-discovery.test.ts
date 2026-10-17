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

const ALLOWED_UAS = ['openai-mcp/1.0.0', 'openai-mcp/1.0.0 (Codex)', 'codex-mcp-client/0.162.0-alpha.17.2'];

function post(method: string, params: object, headers: Record<string, string>) {
  return mcp(new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), {} as any);
}

async function result(response: Response) {
  const text = await response.text();
  const framed = text.match(/^event: message\ndata: (.*)$/m);
  return JSON.parse(framed ? framed[1] : text).result;
}

test('OpenAI and Codex clients can list tools without a token', async () => {
  for (const ua of ALLOWED_UAS) {
    const response = await post('tools/list', {}, { 'user-agent': ua });
    assert.equal(response.status, 200, `${ua} should get the tool list`);
    const { tools } = await result(response);
    assert.ok(tools.length > 0, `${ua} got an empty tool list`);
  }
});

test('OpenAI and Codex clients can initialize without a token', async () => {
  for (const ua of ALLOWED_UAS) {
    const response = await post('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    }, { 'user-agent': ua });
    assert.equal(response.status, 200, `${ua} should be able to initialize`);
    assert.ok((await result(response)).serverInfo, `${ua} got no initialize result`);
  }
});

test('OpenAI and Codex clients still need a token to call a tool', async () => {
  for (const ua of ALLOWED_UAS) {
    const response = await post('tools/call', { name: 'netlify-user-services-reader', arguments: {} }, { 'user-agent': ua });
    assert.equal(response.status, 401, `${ua} tool call should be rejected`);
    assert.match(response.headers.get('WWW-Authenticate') ?? '', /resource_metadata=/);
  }
});

test('an invalid token is still rejected so the client refreshes it', async () => {
  const response = await post('tools/list', {}, {
    'user-agent': 'codex-mcp-client/0.162.0',
    Authorization: 'Bearer not-a-real-token',
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('WWW-Authenticate') ?? '', /error="invalid_token"/);
});

test('every other client still needs a token to list tools', async () => {
  for (const ua of ['Claude-User', 'claude-code/2.1.0 (cli)', 'cursor/1.0', '']) {
    const response = await post('tools/list', {}, ua ? { 'user-agent': ua } : {});
    assert.equal(response.status, 401, `${ua || 'no user agent'} should be rejected`);
  }
});
