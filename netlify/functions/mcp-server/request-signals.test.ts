import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { withRequestSignals, flagAuthChallenge, getAuthChallenge } from './request-signals.ts';

test('flagAuthChallenge is a no-op outside a request scope', () => {
  // No scope established — must not throw, and nothing to read.
  flagAuthChallenge('ignored');
  assert.equal(getAuthChallenge(), undefined);
});

test('flag set inside a scope is readable, carries its description, and scopes are isolated', () => {
  assert.equal(getAuthChallenge(), undefined);

  withRequestSignals(() => {
    assert.equal(getAuthChallenge(), undefined);
    flagAuthChallenge('token expired');
    assert.deepEqual(getAuthChallenge(), { errorDescription: 'token expired' });
  });

  // The flag does not leak out of its scope.
  assert.equal(getAuthChallenge(), undefined);

  // A separate scope starts clean.
  withRequestSignals(() => {
    assert.equal(getAuthChallenge(), undefined);
  });
});

// The load-bearing guarantee: a flag set deep inside a tool callback (which the
// MCP SDK invokes during handler.fetch) is visible to the surrounding request
// scope AFTER the fetch resolves. This is what lets the HTTP handler translate a
// downstream Netlify 401 into an OAuth challenge without sniffing the body.
test('auth challenge flagged inside an SDK tool callback survives back to the handler', async () => {
  const handler = createMcpHandler(async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    server.registerTool('needs-auth', { description: 'simulates a downstream 401' }, async () => {
      // Mirrors authenticatedFetch flagging on a 401, then the tool failing.
      flagAuthChallenge('The Netlify access token is no longer valid');
      throw new Error('NetlifyUnauthError: unauthenticated request to Netlify MCP API');
    });
    return server;
  });

  const rpc = (method: string, params: unknown, id: number, headers: Record<string, string> = {}) =>
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });

  const challenge = await withRequestSignals(async () => {
    // Legacy 2025 handshake, then invoke the failing tool — both within one scope.
    await handler.fetch(
      rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } }, 0),
    );
    const resp = await handler.fetch(
      rpc('tools/call', { name: 'needs-auth', arguments: {} }, 1, { 'mcp-protocol-version': '2025-11-25' }),
    );
    // The SDK swallows the throw into a normal 200 tool result...
    assert.equal(resp.status, 200);
    // ...but the out-of-band signal still made it back to us.
    return getAuthChallenge();
  });

  assert.deepEqual(challenge, { errorDescription: 'The Netlify access token is no longer valid' });
});
