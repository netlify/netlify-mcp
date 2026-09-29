import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkCallbackUrl, isPrivateAddress } from './events/callback-guard.ts';

test('isPrivateAddress blocks loopback, RFC1918, link-local and CGNAT', () => {
  for (const ip of [
    '127.0.0.1', '127.1.2.3',       // loopback
    '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', // RFC 1918
    '169.254.169.254',              // cloud metadata — the classic SSRF target
    '0.0.0.0',
    '100.64.0.1',                   // RFC 6598 CGNAT
    '224.0.0.1', '255.255.255.255', // multicast / reserved
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test('isPrivateAddress allows ordinary public addresses', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '104.16.0.1', '172.32.0.1', '172.15.0.1']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
});

test('isPrivateAddress handles IPv6 including mapped v4', () => {
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('::'), true);
  assert.equal(isPrivateAddress('fe80::1'), true);      // link-local
  assert.equal(isPrivateAddress('fd00::1'), true);      // unique-local
  assert.equal(isPrivateAddress('ff02::1'), true);      // multicast
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true, 'mapped loopback');
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false, 'mapped public');
  assert.equal(isPrivateAddress('2606:4700::1111'), false);
});

test('isPrivateAddress fails closed on non-addresses', () => {
  assert.equal(isPrivateAddress('not-an-ip'), true);
  assert.equal(isPrivateAddress(''), true);
});

test('checkCallbackUrl requires https', async () => {
  assert.deepEqual(await checkCallbackUrl('http://example.com/cb'), { ok: false, reason: 'not-https' });
  assert.deepEqual(await checkCallbackUrl('ftp://example.com/cb'), { ok: false, reason: 'not-https' });
  // A file: URL must not slip through as "not a URL" — it's a valid URL and a
  // wrong protocol.
  assert.deepEqual(await checkCallbackUrl('file:///etc/passwd'), { ok: false, reason: 'not-https' });
});

test('checkCallbackUrl rejects malformed URLs and embedded credentials', async () => {
  assert.deepEqual(await checkCallbackUrl('nonsense'), { ok: false, reason: 'not-a-url' });
  const withCreds = await checkCallbackUrl('https://user:pass@example.com/cb');
  assert.equal(withCreds.ok, false);
  assert.equal(withCreds.reason, 'has-credentials');
});

test('checkCallbackUrl blocks literal private addresses without DNS', async () => {
  for (const url of [
    'https://127.0.0.1/cb',
    'https://169.254.169.254/latest/meta-data',
    'https://10.1.2.3/cb',
    'https://[::1]/cb',
  ]) {
    const result = await checkCallbackUrl(url);
    assert.equal(result.ok, false, `${url} should be blocked`);
    assert.equal(result.reason, 'private-address');
  }
});

test('checkCallbackUrl allows a literal public address', async () => {
  const result = await checkCallbackUrl('https://1.1.1.1/cb');
  assert.equal(result.ok, true);
  assert.deepEqual(result.addresses, ['1.1.1.1']);
});

test('checkCallbackUrl rejects a hostname that does not resolve', async () => {
  // .invalid is reserved by RFC 2606 and must never resolve.
  const result = await checkCallbackUrl('https://this-host-does-not-exist.invalid/cb');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unresolvable');
});

test('checkCallbackUrl blocks a hostname that resolves to loopback', async () => {
  // localhost resolves to 127.0.0.1 / ::1 — the DNS path, not the literal path.
  const result = await checkCallbackUrl('https://localhost/cb');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'private-address');
});
