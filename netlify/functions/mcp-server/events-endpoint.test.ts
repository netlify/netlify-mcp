// End-to-end through the REAL function handler (netlify/functions/mcp.ts), not a
// bare McpServer — auth gate, log context, per-request server factory and all.
//
// This is the test that answers "are we actually exposing any events?", and it
// covers BOTH protocol eras, because they advertise capabilities by different
// routes: the 2025 era answers `initialize`, the 2026 era answers
// `server/discover`. A regression in either one makes the extension invisible to
// half the clients while the other half still works.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.OAUTH_ISSUER = 'https://mcp.example.com';
process.env.JWE_SECRET = 'test-only-auth-jwe-secret-at-least-32-chars';
process.env.EVENTS_RELAY_JWE_SECRET = 'test-only-events-relay-secret-at-least-32-chars';

const realFetch = globalThis.fetch;

// Stand in for every outbound call the handler makes while building a server:
// the auth probe (/api/v1/user) and the coding-context consumer config.
globalThis.fetch = (async (input: any) => {
  const url = String(input?.url ?? input);
  if (url.includes('/api/v1/user')) {
    return new Response(JSON.stringify({ id: 'user-1' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ contextScopes: { general: {} } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const mcp = (await import('../mcp.ts')).default;

// The handler logs to the system-log channel; keep the test output readable.
const origLog = console.log;
before(() => { console.log = () => {}; });
after(() => { console.log = origLog; globalThis.fetch = realFetch; });

// Sourced from the registry rather than hardcoded, so adding or removing an
// event doesn't require touching this file.
const { EVENT_DEFINITIONS } = await import('./events/registry.ts');
const EXPECTED_EVENT_COUNT = Object.keys(EVENT_DEFINITIONS).length;

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
      // A raw nf-prefixed token is accepted directly by getNetlifyAccessToken.
      Authorization: 'Bearer nfp_token_for_tests',
      ...headers,
    },
    body: JSON.stringify(body),
  }), {} as any);

  const text = await response.text();
  // Legacy-era replies are SSE-framed; modern ones are plain JSON.
  const framed = text.match(/^event: message\ndata: (.*)$/m);
  return { status: response.status, body: JSON.parse(framed ? framed[1] : text) };
}

test('legacy-era initialize advertises the events capability', async () => {
  const { status, body } = await post({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
  assert.equal(status, 200);
  assert.equal(body.result.protocolVersion, '2025-11-25');
  assert.deepEqual(
    body.result.capabilities.events, {},
    'a 2025-era client discovers capabilities from initialize — without this it sees no events',
  );
  // Sanity: the rest of the server is still advertised alongside it.
  assert.ok(body.result.capabilities.tools, 'events must not displace the tools capability');
});

test('modern-era server/discover advertises the events capability', async () => {
  const { status, body } = await post(
    { jsonrpc: '2.0', id: 2, method: 'server/discover', params: { _meta: MODERN_META } },
    { 'mcp-protocol-version': '2026-07-28', 'Mcp-Method': 'server/discover' },
  );
  assert.equal(status, 200);
  assert.deepEqual(body.result.capabilities.events, {});
  assert.ok(body.result.supportedVersions.includes('2026-07-28'));
});

test('events/list returns the full catalogue on the legacy era', async () => {
  const { status, body } = await post(
    { jsonrpc: '2.0', id: 3, method: 'events/list', params: {} },
    { 'mcp-protocol-version': '2025-11-25' },
  );
  assert.equal(status, 200);
  assert.equal(body.error, undefined);
  assert.equal(body.result.events.length, EXPECTED_EVENT_COUNT);
});

test('events/list returns the full catalogue on the modern era', async () => {
  const { status, body } = await post(
    { jsonrpc: '2.0', id: 4, method: 'events/list', params: { _meta: MODERN_META } },
    { 'mcp-protocol-version': '2026-07-28', 'Mcp-Method': 'events/list' },
  );
  assert.equal(status, 200);
  assert.equal(body.error, undefined);
  assert.equal(body.result.events.length, EXPECTED_EVENT_COUNT);
  assert.ok(body.result.events.some((e: any) => e.name === 'deploy.started_failing'));
});

test('events/subscribe resolves an identity from a raw PAT bearer', async () => {
  // Regression: the first implementation took the user id from
  // getTokenIdentity(), which is a LOG-attribution helper documented to return
  // null for a raw nfp/nfu/nfo token. That made events/subscribe fail with
  // "Could not identify the authenticated Netlify user" for every PAT user —
  // found only by calling a real deployment, because every earlier test either
  // stopped at local param validation or used no bearer at all.
  //
  // A deliberately unusable callback (link-local) means this stops at the SSRF
  // guard, which is strictly LATER than identity resolution — so reaching that
  // error proves the identity was resolved, and nothing is written.
  const { body } = await post({
    jsonrpc: '2.0', id: 6, method: 'events/subscribe',
    params: {
      name: 'deploy.failed',
      arguments: { site: 'some-site' },
      delivery: {
        mode: 'webhook',
        url: 'https://169.254.169.254/cb',
        secret: 'whsec_' + Buffer.alloc(32, 1).toString('base64'),
      },
    },
  }, { 'mcp-protocol-version': '2025-11-25' });

  assert.ok(body.error, 'expected the unusable callback to be refused');
  assert.equal(
    body.error.message.includes('Could not identify the authenticated Netlify user'),
    false,
    'a raw PAT must resolve to a user id via /api/v1/user',
  );
});

test('an unauthenticated events request gets an auth challenge, not a silent empty list', async () => {
  // The auth gate runs before any MCP dispatch, so a client connecting without
  // a token must be told to authenticate rather than concluding we expose
  // nothing.
  const response = await mcp(new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'events/list', params: {} }),
  }), {} as any);
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate') ?? '', /Bearer/);
});
