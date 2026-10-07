import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSensitive, safeBodySummary } from './logging.ts';

test('redactSensitive masks secrets nested in tool-call arguments', () => {
  const params = {
    name: 'import-claude-design-from-url',
    arguments: { url: 'https://example.com', password: 'hunter2', title: 'ok' },
  };
  const safe = redactSensitive(params);
  assert.equal(safe.arguments.password, '[redacted]');
  assert.equal(safe.arguments.url, 'https://example.com');
  // the original is untouched
  assert.equal(params.arguments.password, 'hunter2');
});

test('redactSensitive keeps numeric JSON-RPC error codes but masks string OAuth codes', () => {
  assert.equal(redactSensitive({ error: { code: -32603 } }).error.code, -32603);
  assert.equal(redactSensitive({ code: 'authz-code-abc' }).code, '[redacted]');
});

test('redactSensitive walks arrays and deep objects', () => {
  const out = redactSensitive([{ a: { refresh_token: 'r1' } }, { access_token: 't2' }]) as any[];
  assert.equal(out[0].a.refresh_token, '[redacted]');
  assert.equal(out[1].access_token, '[redacted]');
});

test('redactSensitive truncates past its depth cap instead of recursing without bound', () => {
  // Build the fixture iteratively (not via JSON.parse, whose own recursive
  // parser can overflow first and mask what we mean to test) just past the cap.
  let deep: any = 1;
  for (let i = 0; i < 100; i++) deep = { a: deep };
  const out = redactSensitive(deep) as any;
  let node = out;
  while (node && typeof node === 'object') node = node.a;
  assert.equal(node, '[redacted: nesting too deep]');
});

test('safeBodySummary never echoes a malformed-JSON body (secrets would land in keys)', () => {
  const truncated = '{"grant_type":"authorization_code","code":"SECRET-AUTH-CODE"';
  const out = safeBodySummary(truncated);
  assert.deepEqual(out, { unparseable: true, length: truncated.length });
  assert.ok(!JSON.stringify(out).includes('SECRET-AUTH-CODE'));
});

test('safeBodySummary still summarizes real form-encoded bodies with redaction', () => {
  const out = safeBodySummary('grant_type=refresh_token&refresh_token=r1&scope=sites');
  assert.deepEqual(out, { grant_type: 'refresh_token', refresh_token: '[redacted]', scope: 'sites' });
});

test('safeBodySummary never logs unknown form field names', () => {
  // A syntactically valid form key that isn't a recognized OAuth param must not
  // be echoed — key-name redaction can't mask a secret carried as a field name.
  const body = 'SECRET-AUTH-CODE=x';
  const out = safeBodySummary(body);
  assert.deepEqual(out, { unparseable: true, length: body.length });
  assert.ok(!JSON.stringify(out).includes('SECRET-AUTH-CODE'));
});

test('safeBodySummary redacts at depth for JSON-RPC bodies', () => {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: 'x', arguments: { password: 'hunter2' } },
  });
  const safe = safeBodySummary(body) as any;
  assert.equal(safe.params.arguments.password, '[redacted]');
});
