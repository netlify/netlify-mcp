import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setMcpClientNameSource, sanitizeAgentName, loginSpawnEnv } from './login-attribution.ts';

test('sets both variables when the client announces claude-code', () => {
  setMcpClientNameSource(() => 'claude-code');
  const env = loginSpawnEnv({});
  assert.equal(env.NETLIFY_LOGIN_SOURCE, 'mcp');
  assert.equal(env.NETLIFY_AGENT, 'claude-code');
});

test('strips characters outside letters, digits, underscore, dot, dash', () => {
  assert.equal(sanitizeAgentName('Claude Code (beta)!/v2 ☃'), 'ClaudeCodebetav2');
});

test('caps the agent name at 64 characters', () => {
  const raw = 'a'.repeat(100);
  const result = sanitizeAgentName(raw);
  assert.equal(result.length, 64);
  assert.equal(result, 'a'.repeat(64));
});

test('omits NETLIFY_AGENT when no client name is known or it cleans to empty', () => {
  setMcpClientNameSource(() => undefined);
  const envWithoutSource = loginSpawnEnv({});
  assert.equal('NETLIFY_AGENT' in envWithoutSource, false);
  assert.equal(envWithoutSource.NETLIFY_LOGIN_SOURCE, 'mcp');

  setMcpClientNameSource(() => '☃☃');
  const envCleanedToEmpty = loginSpawnEnv({});
  assert.equal('NETLIFY_AGENT' in envCleanedToEmpty, false);
  assert.equal(envCleanedToEmpty.NETLIFY_LOGIN_SOURCE, 'mcp');
});

test('keeps the base environment intact', () => {
  setMcpClientNameSource(() => 'claude-code');
  const env = loginSpawnEnv({ PATH: '/x' });
  assert.equal(env.PATH, '/x');
  assert.equal(env.NETLIFY_LOGIN_SOURCE, 'mcp');
  assert.equal(env.NETLIFY_AGENT, 'claude-code');
});
