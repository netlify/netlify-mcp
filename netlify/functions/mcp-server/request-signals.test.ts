import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { withRequestSignals, flagNetlify401, getNetlify401 } from './request-signals.ts';

test('flagNetlify401 is a no-op outside a request scope', () => {
  // No scope established — must not throw, and nothing to read.
  flagNetlify401('/api/v1/ignored');
  assert.equal(getNetlify401(), undefined);
});

test('401 set inside a scope is readable, carries its path, the first wins, and scopes are isolated', () => {
  assert.equal(getNetlify401(), undefined);

  withRequestSignals(() => {
    assert.equal(getNetlify401(), undefined);
    flagNetlify401('/api/v1/sites');
    flagNetlify401('/api/v1/other');
    assert.deepEqual(getNetlify401(), { path: '/api/v1/sites' });
  });

  // The record does not leak out of its scope.
  assert.equal(getNetlify401(), undefined);

  // A separate scope starts clean.
  withRequestSignals(() => {
    assert.equal(getNetlify401(), undefined);
  });
});

// The load-bearing guarantee: a 401 recorded deep inside a tool callback (which
// the MCP SDK invokes during handler.fetch) is visible to the surrounding request
// scope AFTER the fetch resolves. This is what lets the HTTP handler see a
// downstream Netlify 401 without sniffing the body.
test('401 recorded inside an SDK tool callback survives back to the handler', async () => {
  const handler = createMcpHandler(async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    server.registerTool('needs-auth', { description: 'simulates a downstream 401' }, async () => {
      // Mirrors authenticatedFetch recording a 401, then the tool failing.
      flagNetlify401('/api/v1/sites');
      throw new Error('Failed to fetch API: 401');
    });
    return server;
  });

  const rpc = (method: string, params: unknown, id: number, headers: Record<string, string> = {}) =>
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });

  const recorded = await withRequestSignals(async () => {
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
    return getNetlify401();
  });

  assert.deepEqual(recorded, { path: '/api/v1/sites' });
});
