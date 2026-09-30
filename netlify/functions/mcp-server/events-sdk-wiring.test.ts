// Proves the two load-bearing assumptions behind registering an off-spec
// extension on the MCP SDK, because both are undocumented behaviours we depend
// on rather than contracts the SDK promises:
//
//   1. `registerCapabilities({ events: {} })` survives to the wire even though
//      `events` is not in ServerCapabilitiesSchema. It does because
//      `discoverAdvertisedCapabilities` spreads the object without parsing it —
//      if a future SDK starts validating, `server/discover` silently drops the
//      capability and clients stop discovering the extension. This test fails
//      loudly instead.
//   2. The 3-arg `setRequestHandler(method, schemas, handler)` form dispatches
//      a non-spec method name.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

process.env.OAUTH_ISSUER = 'https://mcp.example.com';
process.env.JWE_SECRET = 'test-only-auth-jwe-secret-at-least-32-chars';
// Deliberately NOT setting EVENTS_RELAY_JWE_SECRET: discovery and events/list
// must keep working on a server that has not configured the relay key, so a
// misconfiguration degrades subscribe alone rather than breaking the whole
// extension. The test below asserts that.
delete process.env.EVENTS_RELAY_JWE_SECRET;

const { registerEventMethods } = await import('./events/methods.ts');

// The 2026-07-28 era requires a per-request `_meta` envelope AND an `Mcp-Method`
// header that agrees with the body; without either the SDK rejects before
// dispatch.
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

async function callMcp(method: string, params: Record<string, unknown> = {}) {
  const req = new Request('https://mcp.example.com/mcp', { method: 'POST' });
  const handler = createMcpHandler(async () => {
    const server = new McpServer({ name: 'netlify', version: '0.0.0-test' });
    registerEventMethods(server, req);
    return server;
  });

  const response = await handler.fetch(new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'Mcp-Method': method,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: { ...params, _meta: ENVELOPE },
    }),
  }));

  return JSON.parse(await response.text());
}

test('server/discover advertises the events capability', async () => {
  const body = await callMcp('server/discover');
  assert.deepEqual(
    body.result?.capabilities?.events, {},
    'the events capability did not reach the wire — clients cannot discover the extension',
  );
  assert.ok(body.result.supportedVersions.includes('2026-07-28'));
});

test('events/list dispatches and returns the catalogue', async () => {
  const body = await callMcp('events/list');
  assert.ok(Array.isArray(body.result?.events), 'events/list did not dispatch');
  assert.ok(body.result.events.length > 5);

  const failed = body.result.events.find((e: any) => e.name === 'deploy.failed');
  assert.ok(failed, 'deploy.failed should be advertised');
  assert.deepEqual(failed.delivery, ['webhook']);
  assert.equal(failed.inputSchema.required[0], 'site');
  assert.ok(failed.payloadSchema.properties.error_message);
});

test('discovery and events/list work without the relay key configured', async () => {
  // Already covered above, but stated explicitly: neither path touches
  // EVENTS_RELAY_JWE_SECRET, so a server missing it still advertises the
  // extension and can still be inspected. Only subscribe degrades.
  const discover = await callMcp('server/discover');
  assert.deepEqual(discover.result?.capabilities?.events, {});
  const list = await callMcp('events/list');
  assert.ok(list.result?.events?.length > 5);
});

test('subscribe reports a missing relay key as a server problem, not a bad request', async () => {
  const body = await callMcp('events/subscribe', {
    name: 'deploy.failed',
    arguments: { site: 'my-site' },
    delivery: { mode: 'webhook', url: 'https://1.1.1.1/cb', secret: 'whsec_' + Buffer.alloc(32, 1).toString('base64') },
  });
  assert.ok(body.error);
  // Whatever the failure, the message must not leak the env var name into a
  // conversation, and must not blame the caller's request.
  assert.equal(body.error.message.includes('EVENTS_RELAY_JWE_SECRET'), false);
});

test('an unknown events method is a clean method-not-found', async () => {
  const body = await callMcp('events/nope');
  assert.equal(body.error?.code, -32601);
});

test('events/subscribe rejects an unknown event name before touching netlify', async () => {
  const body = await callMcp('events/subscribe', {
    name: 'deploy.does_not_exist',
    arguments: { site: 'my-site' },
    delivery: { mode: 'webhook', url: 'https://example.com/cb', secret: 'whsec_' + Buffer.alloc(32, 1).toString('base64') },
  });
  assert.ok(body.error, 'should be an error');
  assert.match(body.error.message, /Unknown event/);
  assert.match(body.error.message, /events\/list/, 'the message should point the model at the fix');
  // A caller-fixable refusal must not look like a server bug, or a client will
  // retry it or report it as our fault instead of correcting the request.
  assert.equal(body.error.code, -32602, 'should be INVALID_PARAMS, not INTERNAL_ERROR');
});

test('events/subscribe rejects a malformed signing secret', async () => {
  const body = await callMcp('events/subscribe', {
    name: 'deploy.failed',
    arguments: { site: 'my-site' },
    delivery: { mode: 'webhook', url: 'https://example.com/cb', secret: 'whsec_tooshort' },
  });
  assert.ok(body.error);
  assert.match(body.error.message, /whsec_/);
});

test('events/subscribe requires a webhook delivery mode', async () => {
  // The extension only defines webhook delivery; polling and streaming are out.
  const body = await callMcp('events/subscribe', {
    name: 'deploy.failed',
    arguments: { site: 'my-site' },
    delivery: { mode: 'polling', url: 'https://example.com/cb' },
  });
  assert.ok(body.error, 'a non-webhook delivery mode must be refused by the schema');
});

test('events/subscribe rejects an unrecognised context filter', async () => {
  // Passing it through would create a subscription whose filter matches no
  // real deploy context, so it would silently never deliver — the worst
  // failure mode for a notification. Reject instead.
  const body = await callMcp('events/subscribe', {
    name: 'deploy.failed',
    arguments: { site: 'my-site', context: 'prod' },
    delivery: { mode: 'webhook', url: 'https://example.com/cb', secret: 'whsec_' + Buffer.alloc(32, 1).toString('base64') },
  });
  assert.ok(body.error);
  assert.equal(body.error.code, -32602);
  assert.match(body.error.message, /Invalid "context" filter "prod"/);
  assert.match(body.error.message, /production/, 'the message should list the valid values');
});

test('events/subscribe accepts each advertised context value', async () => {
  for (const context of ['production', 'branch-deploy', 'deploy-preview']) {
    const body = await callMcp('events/subscribe', {
      name: 'deploy.failed',
      arguments: { site: 'my-site', context },
      delivery: { mode: 'webhook', url: 'https://example.com/cb', secret: 'whsec_' + Buffer.alloc(32, 1).toString('base64') },
    });
    // Each still fails later (no auth/site here) but must NOT fail on context.
    assert.equal(
      /Invalid "context" filter/.test(body.error?.message ?? ''), false,
      `${context} should be accepted`,
    );
  }
});

test('events/subscribe requires a site argument', async () => {
  const body = await callMcp('events/subscribe', {
    name: 'deploy.failed',
    arguments: {},
    delivery: { mode: 'webhook', url: 'https://example.com/cb', secret: 'whsec_' + Buffer.alloc(32, 1).toString('base64') },
  });
  assert.ok(body.error);
  assert.match(body.error.message, /site/);
});
