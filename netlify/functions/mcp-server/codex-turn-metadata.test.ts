// Drives the REAL handler (netlify/functions/mcp.ts): Codex identifies the
// conversation a tool call belongs to in `_meta["x-codex-turn-metadata"]`, and
// those ids should land on every log line for that request.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.OAUTH_ISSUER = 'https://mcp.example.com';
process.env.JWE_SECRET = 'test-only-auth-jwe-secret-at-least-32-chars';
process.env.EVENTS_RELAY_JWE_SECRET = 'test-only-events-relay-secret-at-least-32-chars';

// The handler confirms a token against the Netlify API before a tool call, so
// stub that one lookup. Whether the tool then succeeds doesn't matter: the
// "tool call" line is logged before dispatch, which is all these tests check.
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
const { createJWE } = await import('./utils.ts');

const origLog = console.log;
let logged: string[] = [];
before(() => { console.log = (line: unknown) => { logged.push(String(line)); }; });
after(() => { console.log = origLog; globalThis.fetch = realFetch; });
beforeEach(() => { logged = []; });

function loggedEntries(message: string) {
  return logged
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line))
    .filter(entry => entry.message === message);
}

const CODEX_UA = 'codex-mcp-client/0.163.0';

async function post(body: object, headers: Record<string, string> = {}) {
  const token = await createJWE({ accessToken: 'nfp_test_token', identity: { userId: 'u1', teamId: 't1' } }, '1h');
  return mcp(new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      'user-agent': CODEX_UA,
      Authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...body }),
  }), {} as any);
}

const TOOL_CALL = { method: 'tools/call', id: 1, params: { name: 'netlify-user-services-reader', arguments: {} } };

test('a Codex tool call logs its session, thread and turn ids', async () => {
  await post({
    ...TOOL_CALL,
    params: {
      ...TOOL_CALL.params,
      _meta: {
        callId: 'call_1',
        'x-codex-turn-metadata': {
          session_id: 'sess-123',
          thread_id: 'thread-456',
          turn_id: 'turn-789',
          codex_version: '0.163.0',
        },
      },
    },
  });
  const [entry] = loggedEntries('tool call');
  assert.ok(entry, 'the tool call should be logged');
  assert.equal(entry.codexSessionId, 'sess-123');
  assert.equal(entry.codexThreadId, 'thread-456');
  assert.equal(entry.codexTurnId, 'turn-789');
  assert.equal(entry.codex_version, undefined, 'only the ids are lifted out');
});

test('a call without Codex turn metadata logs no Codex ids', async () => {
  await post(TOOL_CALL);
  const [entry] = loggedEntries('tool call');
  assert.ok(entry, 'the tool call should be logged');
  assert.equal(entry.codexSessionId, undefined);
  assert.equal(entry.codexThreadId, undefined);
  assert.equal(entry.codexTurnId, undefined);
});

test('non-string ids are dropped and long ones are bounded', async () => {
  await post({
    ...TOOL_CALL,
    params: {
      ...TOOL_CALL.params,
      _meta: { 'x-codex-turn-metadata': { session_id: 'x'.repeat(500), thread_id: 42, turn_id: { nested: true } } },
    },
  });
  const [entry] = loggedEntries('tool call');
  assert.ok(entry, 'the tool call should be logged');
  assert.equal(entry.codexSessionId, 'x'.repeat(200));
  assert.equal(entry.codexThreadId, undefined);
  assert.equal(entry.codexTurnId, undefined);
});
