import { test } from 'node:test';
import assert from 'node:assert/strict';

import { attributionParams, canonicalAgent, cleanClientName } from './agent-attribution.ts';
import { handleAuthStart, handleClientRegistration } from './auth-flow.ts';
import { staticClients } from './oauth-clients.ts';

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

// Handler-level: register a client via handleClientRegistration, then confirm
// handleAuthStart's redirect carries (or omits) the attribution params.

const REDIRECT_URI = 'https://client.example.com/cb';

async function registerClientId(clientName?: string): Promise<string> {
  const body: Record<string, unknown> = { redirect_uris: [REDIRECT_URI] };
  if (clientName !== undefined) {
    body.client_name = clientName;
  }
  const response = await handleClientRegistration(
    new Request('http://localhost:8888/oauth-server/reg', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    [],
  );
  const { client_id } = JSON.parse(response.body as string) as { client_id: string };
  return client_id;
}

function authStartRequest(clientId: string, redirectUri: string): Request {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: 'abc',
    code_challenge_method: 'S256',
  });
  return new Request(`http://localhost:8888/oauth-server/authorize?${params.toString()}`);
}

test('handleAuthStart: redirect carries utm_content and utm_term for client_name: Claude', async () => {
  const clientId = await registerClientId('Claude');
  const response = await handleAuthStart(authStartRequest(clientId, REDIRECT_URI));
  assert.equal(response.statusCode, 302);
  const location = String(response.headers?.Location);
  assert.ok(location.includes('utm_source=mcp&utm_campaign=integrations&utm_content=claudeai&utm_term=client_name:Claude'));
});

test('handleAuthStart: redirect for a registration with no client_name omits attribution params', async () => {
  const clientId = await registerClientId();
  const response = await handleAuthStart(authStartRequest(clientId, REDIRECT_URI));
  const location = String(response.headers?.Location);
  assert.ok(location.includes('utm_campaign=integrations'));
  assert.ok(!location.includes('utm_content'));
  assert.ok(!location.includes('utm_term'));
});

test('handleAuthStart: redirect for a static client omits utm_content', async () => {
  const staticClient = staticClients[0];
  const response = await handleAuthStart(authStartRequest(staticClient.client_id, staticClient.redirect_uris[0]));
  const location = String(response.headers?.Location);
  assert.ok(!location.includes('utm_content'));
});
