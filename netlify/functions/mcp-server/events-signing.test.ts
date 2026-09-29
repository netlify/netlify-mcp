import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';

import {
  decodeWebhookSecret,
  signOutboundDelivery,
  verifyNetlifySignature,
} from './events/signing.ts';

const SECRET_BYTES = Buffer.alloc(32, 9);
const WHSEC = 'whsec_' + SECRET_BYTES.toString('base64');

test('decodeWebhookSecret accepts a whsec_ secret in the 24-64 byte range', () => {
  assert.deepEqual(decodeWebhookSecret(WHSEC), SECRET_BYTES);
  // The prefix is optional in the wild; accept a bare base64 value too.
  assert.deepEqual(decodeWebhookSecret(SECRET_BYTES.toString('base64')), SECRET_BYTES);
});

test('decodeWebhookSecret rejects out-of-range and malformed secrets', () => {
  assert.equal(decodeWebhookSecret('whsec_' + Buffer.alloc(16, 1).toString('base64')), null, '16 bytes is too short');
  assert.equal(decodeWebhookSecret('whsec_' + Buffer.alloc(80, 1).toString('base64')), null, '80 bytes is too long');
  assert.equal(decodeWebhookSecret('whsec_not base64!'), null);
  assert.equal(decodeWebhookSecret(''), null);
});

test('signOutboundDelivery matches the Standard Webhooks scheme', () => {
  const now = new Date(1_760_000_000_000);
  const body = JSON.stringify({ hello: 'world' });
  const headers = signOutboundDelivery({
    eventId: 'evt_1',
    subscriptionId: 'sub_1',
    body,
    secret: WHSEC,
    now,
  });
  assert.ok(headers);

  const timestamp = String(Math.floor(now.getTime() / 1000));
  // id.timestamp.payload, HMAC-SHA256, base64, "v1," prefixed.
  const expected = createHmac('sha256', SECRET_BYTES)
    .update(`evt_1.${timestamp}.${body}`)
    .digest('base64');

  assert.equal(headers['webhook-id'], 'evt_1');
  assert.equal(headers['webhook-timestamp'], timestamp);
  assert.equal(headers['webhook-signature'], `v1,${expected}`);
  assert.equal(headers['X-MCP-Subscription-Id'], 'sub_1');
  assert.equal(headers['Content-Type'], 'application/json');
});

test('signOutboundDelivery re-signs with a fresh timestamp per attempt', () => {
  const body = '{}';
  const first = signOutboundDelivery({
    eventId: 'evt_1', subscriptionId: 'sub_1', body, secret: WHSEC,
    now: new Date(1_760_000_000_000),
  });
  const second = signOutboundDelivery({
    eventId: 'evt_1', subscriptionId: 'sub_1', body, secret: WHSEC,
    now: new Date(1_760_000_060_000),
  });
  // The event id is preserved across attempts (so subscribers can dedupe) while
  // the timestamp and therefore the signature change.
  assert.equal(first?.['webhook-id'], second?.['webhook-id']);
  assert.notEqual(first?.['webhook-timestamp'], second?.['webhook-timestamp']);
  assert.notEqual(first?.['webhook-signature'], second?.['webhook-signature']);
});

test('signOutboundDelivery returns null for an unusable secret', () => {
  assert.equal(signOutboundDelivery({
    eventId: 'e', subscriptionId: 's', body: '{}', secret: 'whsec_short',
  }), null);
});

// --- inbound: Netlify's JWS -------------------------------------------------

/** Build the same signature bitballoon's Hook::HttpTrigger.sign produces. */
function netlifySign(secret: string, body: string, overrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'HS256', ...(overrides.header as object ?? {}) }))
    .toString('base64url');
  const claims = {
    iss: 'netlify',
    sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    ...(overrides.claims as object ?? {}),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

test('verifyNetlifySignature accepts a genuine Netlify signature', () => {
  const body = JSON.stringify({ id: 'deploy-1', state: 'error' });
  assert.equal(verifyNetlifySignature({
    signature: netlifySign('shhh', body),
    rawBody: body,
    secret: 'shhh',
  }), true);
});

test('verifyNetlifySignature rejects a body swapped after signing', () => {
  // The JWT only signs a digest, so a valid signature over a DIFFERENT body
  // must still fail — this is the check that binds signature to bytes.
  const signedBody = JSON.stringify({ id: 'deploy-1', state: 'error' });
  const attackerBody = JSON.stringify({ id: 'deploy-1', state: 'ready' });
  assert.equal(verifyNetlifySignature({
    signature: netlifySign('shhh', signedBody),
    rawBody: attackerBody,
    secret: 'shhh',
  }), false);
});

test('verifyNetlifySignature rejects the wrong secret, issuer, and alg', () => {
  const body = '{"id":"d"}';
  assert.equal(verifyNetlifySignature({
    signature: netlifySign('other-secret', body), rawBody: body, secret: 'shhh',
  }), false, 'wrong secret');

  assert.equal(verifyNetlifySignature({
    signature: netlifySign('shhh', body, { claims: { iss: 'attacker' } }),
    rawBody: body, secret: 'shhh',
  }), false, 'wrong issuer');

  // alg:none must never be honoured from the header.
  assert.equal(verifyNetlifySignature({
    signature: netlifySign('shhh', body, { header: { alg: 'none' } }),
    rawBody: body, secret: 'shhh',
  }), false, 'alg none');
});

test('verifyNetlifySignature rejects missing and malformed signatures', () => {
  assert.equal(verifyNetlifySignature({ signature: null, rawBody: '{}', secret: 's' }), false);
  assert.equal(verifyNetlifySignature({ signature: 'a.b', rawBody: '{}', secret: 's' }), false);
  assert.equal(verifyNetlifySignature({ signature: 'not.a.jwt', rawBody: '{}', secret: 's' }), false);
});
