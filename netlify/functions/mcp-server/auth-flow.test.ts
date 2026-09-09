import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleClientRegistration } from './auth-flow.ts';
import { resolveClient } from './client-registry.ts';
import { SUPPORTED_SCOPES } from './oauth-config.ts';

// These tests round-trip createJWE/decryptJWE on the localhost dev key, which
// requires JWE_SECRET to be unset regardless of what the ambient shell env has.
delete process.env.JWE_SECRET;

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

  const rawLine = lines.find((line) => {
    try {
      return JSON.parse(line).message === REGISTER_LOG_MESSAGE;
    } catch {
      return false;
    }
  });
  const parsed = rawLine ? JSON.parse(rawLine) : undefined;

  return { response, parsed, rawLine };
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
  const { response, parsed } = await captureRegisterLog({
    redirect_uris: ['http://127.0.0.1:1234/cb'],
    client_name: longName,
  });

  assert.ok(parsed);
  assert.equal(parsed.client_name.length, 200);

  const responseBody = JSON.parse(response.body);
  assert.equal(responseBody.client_name, longName);

  const { client } = await resolveClient(responseBody.client_id);
  assert.ok(client);
  assert.equal(client.client_name, longName);
});

test('register: omits client_name from the log line when the client sends none', async () => {
  const { parsed } = await captureRegisterLog({
    redirect_uris: ['http://127.0.0.1:1234/cb'],
  });

  assert.ok(parsed);
  assert.equal('client_name' in parsed, false);
});

test('register: logged redirect_hosts are bounded and never leak uri secrets, but the response is not', async () => {
  const loopbackUri = 'http://127.0.0.1:4321/cb';
  const taggedUris = Array.from(
    { length: 15 },
    (_, i) => `https://user:pw@example.com/cb?email=a@b.c&token=secret-marker#frag-${i}`,
  );
  const redirectUris = [loopbackUri, ...taggedUris];

  const { response, parsed, rawLine } = await captureRegisterLog({ redirect_uris: redirectUris });

  assert.ok(parsed);
  assert.ok(rawLine);
  assert.deepEqual(parsed.redirect_hosts, ['127.0.0.1:4321', ...Array(9).fill('example.com')]);
  assert.ok(!rawLine.includes('secret-marker'));
  assert.ok(!rawLine.includes('user:pw'));
  assert.ok(!rawLine.includes('email='));

  assert.equal(response.statusCode, 201);
  const responseBody = JSON.parse(response.body);
  assert.equal(responseBody.redirect_uris.length, 16);
  assert.deepEqual(responseBody.redirect_uris, redirectUris);
});

test('register: logged redirect_hosts are length-bounded for a long host', async () => {
  const longHostUri = `https://${'a'.repeat(5000)}.com/cb`;
  const { response, parsed } = await captureRegisterLog({ redirect_uris: [longHostUri] });

  assert.ok(parsed);
  assert.equal(parsed.redirect_hosts[0].length, 200);

  assert.equal(response.statusCode, 201);
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
  const responseBody = JSON.parse(response.body);
  assert.equal(responseBody.scope, repeatedScope);

  const { client } = await resolveClient(responseBody.client_id);
  assert.ok(client);
  assert.equal(client.scope, repeatedScope);
});
