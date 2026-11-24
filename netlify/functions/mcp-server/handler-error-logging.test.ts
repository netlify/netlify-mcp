// Drives the REAL handler (netlify/functions/mcp.ts) with requests the SDK rejects.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.OAUTH_ISSUER = 'https://mcp.example.com';
process.env.JWE_SECRET = 'test-only-auth-jwe-secret-at-least-32-chars';
process.env.EVENTS_RELAY_JWE_SECRET = 'test-only-events-relay-secret-at-least-32-chars';

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  const url = String(input?.url ?? input);
  if (!url.includes('/api/v1/user')) return realFetch(input, init);
  return new Response(JSON.stringify({ id: 'u1' }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const mcp = (await import('../mcp.ts')).default;
const { createJWE } = await import('./utils.ts');

const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
let logged: { level: string; line: string }[] = [];
before(() => {
  console.log = (line: unknown) => { logged.push({ level: 'log', line: String(line) }); };
  console.warn = (line: unknown) => { logged.push({ level: 'warn', line: String(line) }); };
  console.error = (line: unknown) => { logged.push({ level: 'error', line: String(line) }); };
});
after(() => {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;
  globalThis.fetch = realFetch;
});
beforeEach(() => { logged = []; });

function handlerErrorLines() {
  return logged
    .filter(({ line }) => line.startsWith('{'))
    .map(({ level, line }) => ({ stream: level, entry: JSON.parse(line) }))
    .filter(({ entry }) => entry.message === 'mcp handler error');
}

const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

async function modernRequest(method: string, params: Record<string, unknown>, headers: Record<string, string>) {
  const token = await createJWE({ accessToken: 'nfp_test_token', identity: { userId: 'u1', teamId: 't1' } }, '1h');
  return mcp(new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      Authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method, id: 1, params: { _meta: ENVELOPE, ...params } }),
  }), {} as any);
}

test('a request without an Mcp-Method header is logged as a warning', async () => {
  const response = await modernRequest('server/discover', {}, {});
  assert.equal(response.status, 400);

  const lines = handlerErrorLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].stream, 'warn');
  assert.equal(lines[0].entry.level, 'warn');
  assert.match(lines[0].entry.err.message, /method-header-missing/);
});

test('a request missing a different header is still logged as an error', async () => {
  const response = await modernRequest(
    'tools/call',
    { name: 'netlify-user-services-reader', arguments: {} },
    { 'Mcp-Method': 'tools/call' },
  );
  assert.equal(response.status, 400);

  const lines = handlerErrorLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].stream, 'error');
  assert.equal(lines[0].entry.level, 'error');
  assert.match(lines[0].entry.err.message, /name-header-missing/);
});

test('a mismatched Mcp-Method header is still logged as an error, whatever it says', async () => {
  const response = await modernRequest('server/discover', {}, { 'Mcp-Method': 'method-header-missing' });
  assert.equal(response.status, 400);

  const lines = handlerErrorLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].stream, 'error');
  assert.equal(lines[0].entry.level, 'error');
  assert.match(lines[0].entry.err.message, /method-header-mismatch/);
});
