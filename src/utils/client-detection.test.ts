import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isClaudeMCPClient } from './client-detection.ts';

const reqWithUA = (ua?: string) =>
  new Request('https://example.com/mcp', { method: 'POST', headers: ua ? { 'user-agent': ua } : {} });

test('recognizes Claude clients by user-agent on any request', () => {
  assert.ok(isClaudeMCPClient(reqWithUA('Claude-User'), {}));
  assert.ok(isClaudeMCPClient(reqWithUA('anthropic-mcp-client/1.0'), {}));
});

test('recognizes Claude clients by clientInfo on initialize', () => {
  const body = { method: 'initialize', params: { clientInfo: { name: 'claude-ai', version: '1' } } };
  assert.ok(isClaudeMCPClient(reqWithUA('python-httpx/0.27'), body));
});

test('excludes Claude Code, the one Claude surface identifiable by user-agent', () => {
  assert.ok(!isClaudeMCPClient(reqWithUA('claude-code/2.1.196 (cli)'), {}));
  assert.ok(!isClaudeMCPClient(reqWithUA('node'), { params: { clientInfo: { name: 'claude-code' } } }));
});

test('rejects other agents and missing signals', () => {
  assert.ok(!isClaudeMCPClient(reqWithUA('codex-cli/1.0'), {}));
  assert.ok(!isClaudeMCPClient(reqWithUA('Gemini-MCP/2.0'), { method: 'tools/list' }));
  assert.ok(!isClaudeMCPClient(reqWithUA('openrouter/1.0'), null));
  assert.ok(!isClaudeMCPClient(reqWithUA(undefined), {}));
  assert.ok(
    !isClaudeMCPClient(reqWithUA('curl/8.0'), { method: 'initialize', params: { clientInfo: { name: 'cursor' } } }),
  );
});
