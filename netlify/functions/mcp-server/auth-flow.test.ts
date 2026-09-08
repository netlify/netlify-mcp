import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleClientRegistration } from './auth-flow.ts';
import { SUPPORTED_SCOPES } from './oauth-config.ts';

// These tests run against the localhost dev key (no OAUTH_ISSUER / JWE_SECRET
// set), which is exactly the stateless round-trip we depend on in production.
// register: issued stateless client_id is logged at info, which is not gated
// by MCP_VERBOSE_LOGGING, so no env setup is needed to observe it.

const REGISTER_LOG_MESSAGE = 'register: issued stateless client_id';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/register', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function captureRegisterLog(body: Record<string, unknown>) {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (line: string) => {
    lines.push(line);
  };
  let response: any;
  try {
    response = await handleClientRegistration(makeRequest(body), SUPPORTED_SCOPES);
  } finally {
    console.log = origLog;
  }

  const parsed = lines
    .map((line) => JSON.parse(line))
    .find((entry) => entry.message === REGISTER_LOG_MESSAGE);

  return { response, parsed };
}

test('register: logs client_name at info when the client sends one', async () => {
  const { response, parsed } = await captureRegisterLog({
    redirect_uris: ['http://127.0.0.1:1234/cb'],
    client_name: 'Claude Code',
  });

  assert.equal(response.statusCode, 201);
  assert.ok(parsed);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.client_name, 'Claude Code');
});

test('register: logged client_name is truncated to 200 characters', async () => {
  const longName = 'x'.repeat(300);
  const { parsed } = await captureRegisterLog({
    redirect_uris: ['http://127.0.0.1:1234/cb'],
    client_name: longName,
  });

  assert.ok(parsed);
  assert.equal(parsed.client_name.length, 200);
});

test('register: omits client_name from the log line when the client sends none', async () => {
  const { parsed } = await captureRegisterLog({
    redirect_uris: ['http://127.0.0.1:1234/cb'],
  });

  assert.ok(parsed);
  assert.equal('client_name' in parsed, false);
});

test('register: logged redirect_uris are bounded in count and length, but the response is not', async () => {
  const longRedirectUris = Array.from(
    { length: 15 },
    (_, i) => `http://127.0.0.1:1234/${'x'.repeat(200)}-${i}`,
  );
  const { response, parsed } = await captureRegisterLog({
    redirect_uris: longRedirectUris,
  });

  assert.ok(parsed);
  assert.equal(parsed.redirect_uris.length, 10);
  assert.ok(parsed.redirect_uris.every((uri: string) => uri.length === 200));

  assert.equal(response.statusCode, 201);
  assert.equal(JSON.parse(response.body).redirect_uris.length, 15);
});

test('register: logged scope is truncated to 200 characters', async () => {
  const repeatedScope = Array.from({ length: 500 }, () => SUPPORTED_SCOPES[0]).join(' ');
  const { response, parsed } = await captureRegisterLog({
    redirect_uris: ['http://127.0.0.1:1234/cb'],
    scope: repeatedScope,
  });

  assert.ok(parsed);
  assert.equal(parsed.scope.length, 200);

  assert.equal(response.statusCode, 201);
});
