import { test } from 'node:test';
import assert from 'node:assert/strict';

import { attributionParams, canonicalAgent, cleanClientName } from './agent-attribution.ts';

// One test per seed row, generated in a loop so each row is its own named
// test. Display names are realistic (not the normalized keys themselves) to
// exercise the normalization: case, spaces, and punctuation.
const CANONICAL_AGENT_CASES: Array<[string, string]> = [
  ['Claude', 'claudeai'],
  ['claude-ai', 'claudeai'],
  ['Claude Desktop', 'claudeai'],
  ['Claude Code', 'claude'],
  ['Cursor', 'cursor'],
  ['ChatGPT', 'chatgpt'],
  ['OpenAI', 'chatgpt'],
  ['Windsurf', 'windsurf'],
  ['Codeium', 'windsurf'],
  ['Visual Studio Code', 'copilot'],
  ['VS Code', 'copilot'],
  ['GitHub Copilot', 'copilot'],
  ['Gemini CLI', 'gemini'],
  ['Codex', 'codex'],
];

for (const [input, expected] of CANONICAL_AGENT_CASES) {
  test(`canonicalAgent: ${input} -> ${expected}`, () => {
    assert.equal(canonicalAgent(input), expected);
  });
}

test('canonicalAgent: unrecognized name falls back to other', () => {
  assert.equal(canonicalAgent('Some Random Agent'), 'other');
});

test('canonicalAgent: empty string falls back to other', () => {
  assert.equal(canonicalAgent(''), 'other');
});

test('cleanClientName: strips disallowed characters', () => {
  assert.equal(cleanClientName('Claude Code (v1.2)'), 'ClaudeCodev1.2');
});

test('cleanClientName: keeps every allowed character', () => {
  assert.equal(cleanClientName('my_agent.v2:beta-1'), 'my_agent.v2:beta-1');
});

test('cleanClientName: caps a 100-char name at exactly 64', () => {
  const longName = 'a'.repeat(100);
  const cleaned = cleanClientName(longName);
  assert.equal(cleaned.length, 64);
  assert.equal(cleaned, 'a'.repeat(64));
});

test('attributionParams: undefined client_name returns empty string', () => {
  assert.equal(attributionParams(undefined), '');
});

test('attributionParams: empty client_name returns empty string', () => {
  assert.equal(attributionParams(''), '');
});

test('attributionParams: builds utm_content and utm_term for a known agent', () => {
  assert.equal(attributionParams('Claude'), '&utm_content=claudeai&utm_term=client_name:Claude');
});
