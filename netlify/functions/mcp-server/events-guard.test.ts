import { test } from 'node:test';
import assert from 'node:assert/strict';

import http from 'node:http';

import { checkCallbackUrl, isPrivateAddress, verifyCallbackUrl } from './events/callback-guard.ts';

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

test('isPrivateAddress treats everything outside global unicast as private', () => {
  // Allowlist rather than range enumeration: only 2000::/3 is public, which
  // covers ::1, link-local, unique-local, multicast, mapped v4 and NAT64 with
  // no address parsing. These are the forms a HOSTNAME can resolve to.
  for (const ip of [
    '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1',
    '::ffff:7f00:1',    // the hexadecimal form of ::ffff:127.0.0.1
    '::ffff:a9fe:a9fe', // 169.254.169.254, the cloud metadata address
    '64:ff9b::7f00:1',  // NAT64-wrapped loopback
    '2002:7f00:1::',    // 6to4-wrapped loopback, inside 2000::/3
    '::7f00:1',         // deprecated IPv4-compatible
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test('isPrivateAddress allows ordinary public IPv6', () => {
  assert.equal(isPrivateAddress('2606:4700::1111'), false);
  assert.equal(isPrivateAddress('2001:4860:4860::8888'), false);
  assert.equal(isPrivateAddress('3fff::1'), false, 'top of 2000::/3');
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

test('checkCallbackUrl refuses IP-literal hosts outright', async () => {
  // A real subscriber always has a DNS name, so literals are refused rather
  // than vetted. That removes a whole class of bypass: WHATWG URL rewrites an
  // IPv6 host into compressed hex, so `https://[::ffff:127.0.0.1]` arrives as
  // `::ffff:7f00:1` and any literal-matching scheme has a second spelling of
  // every address to get right. Public literals are refused too — the point is
  // that we never have to reason about which is which.
  for (const url of [
    'https://127.0.0.1/cb',
    'https://169.254.169.254/latest/meta-data',
    'https://10.1.2.3/cb',
    'https://1.1.1.1/cb',
    'https://[::1]/cb',
    'https://[::ffff:127.0.0.1]/cb',
    'https://[::ffff:169.254.169.254]/latest/meta-data',
    'https://[2002:7f00:1::]/cb',
    'https://[2606:4700::1111]/cb',
  ]) {
    const result = await checkCallbackUrl(url);
    assert.equal(result.ok, false, `${url} should be refused`);
    assert.equal(result.reason, 'ip-literal', `${url} should be refused as a literal`);
  }
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

// --- nobody may redirect a vetted request somewhere else -------------------

test("the runtime honours redirect:'error' — a 302 is refused, not followed", async () => {
  // This is the guard that stops a subscriber sending us somewhere else AFTER
  // its host has been vetted: answer a delivery with a 302 and the request
  // would land wherever it points. We pass redirect:'error' on both outbound
  // paths, but that only helps if the runtime enforces it — so exercise it for
  // real rather than asserting the option was set. A Node/undici change that
  // weakened this would otherwise pass silently.
  const landing = http.createServer((_req, res) => { res.writeHead(200); res.end('REDIRECTED'); });
  await new Promise<void>((r) => landing.listen(0, '127.0.0.1', () => r()));
  const landingPort = (landing.address() as any).port;

  const redirector = http.createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${landingPort}/` });
    res.end();
  });
  await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(redirector.address() as any).port}/cb`;

  try {
    await assert.rejects(
      () => fetch(url, { method: 'POST', body: '{}', redirect: 'error' }),
      'a redirect must throw rather than be followed',
    );
    // Control: the same request WOULD be redirected without the option, which
    // is what makes the assertion above meaningful.
    const followed = await fetch(url, { method: 'POST', body: '{}', redirect: 'follow' });
    assert.equal(await followed.text(), 'REDIRECTED');
  } finally {
    landing.close();
    redirector.close();
  }
});

test('verifyCallbackUrl refuses redirects on the handshake too', async () => {
  const realFetch = globalThis.fetch;
  let sawRedirectOption: string | undefined;
  globalThis.fetch = (async (_input: any, init: any) => {
    sawRedirectOption = init?.redirect;
    return new Response(JSON.stringify({ challenge: 'abc' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const result = await verifyCallbackUrl({
      callbackUrl: 'https://example.com/cb',
      secret: 'whsec_' + Buffer.alloc(32, 1).toString('base64'),
      subscriptionId: 'sub_1',
      challenge: 'abc',
    });
    assert.equal(result.ok, true);
    assert.equal(sawRedirectOption, 'error', 'the handshake must not follow redirects either');
  } finally {
    globalThis.fetch = realFetch;
  }
});
