// Two unrelated signing schemes meet in the relay. They are easy to confuse in
// review, so they live in separate functions whose names say which direction
// they serve:
//
//   INBOUND  (Netlify -> relay): HS256 JWT over {iss:"netlify", sha256:<hex>},
//            in `x-webhook-signature`. Signed with the per-hook
//            `signature_secret` we set when creating the hook.
//            (bitballoon: Hook::HttpTrigger.sign)
//
//   OUTBOUND (relay -> client): Standard Webhooks. HMAC-SHA256 over
//            `<id>.<timestamp>.<body>`, base64, prefixed `v1,`. Signed with the
//            `whsec_`-prefixed secret the client gave us at subscribe time.
//            (https://github.com/standard-webhooks/standard-webhooks)

import { createHmac, createHash } from 'node:crypto';
import { secureEquals } from './subscription.ts';

// ---------------------------------------------------------------------------
// OUTBOUND: Standard Webhooks
// ---------------------------------------------------------------------------

// Indexable so it can be handed straight to `fetch` as HeadersInit.
export type SignedHeaders = Record<string, string> & {
  'Content-Type': string;
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
  'X-MCP-Subscription-Id': string;
};

/**
 * Decode a `whsec_`-prefixed secret to its raw key bytes. The extension requires
 * "a `whsec_` signing secret whose base64 value decodes to 24–64 bytes"; we
 * enforce that at subscribe time so a malformed secret fails the subscription
 * rather than every delivery.
 */
export function decodeWebhookSecret(secret: string): Buffer | null {
  if (typeof secret !== 'string') return null;
  const base64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(base64)) return null;
  let key: Buffer;
  try {
    key = Buffer.from(base64, 'base64');
  } catch {
    return null;
  }
  if (key.length < 24 || key.length > 64) return null;
  return key;
}

/**
 * Build the Standard Webhooks headers for one delivery attempt. Called fresh per
 * attempt: the extension requires preserving the event id across retries while
 * generating "a fresh signing timestamp and signature for each attempt", so the
 * timestamp must not be hoisted out of the retry loop.
 */
export function signOutboundDelivery(args: {
  eventId: string;
  subscriptionId: string;
  body: string;
  secret: string;
  now?: Date;
}): SignedHeaders | null {
  const key = decodeWebhookSecret(args.secret);
  if (!key) return null;

  const timestamp = Math.floor((args.now ?? new Date()).getTime() / 1000).toString();
  const signedContent = `${args.eventId}.${timestamp}.${args.body}`;
  const signature = createHmac('sha256', key).update(signedContent).digest('base64');

  return {
    'Content-Type': 'application/json',
    'webhook-id': args.eventId,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${signature}`,
    'X-MCP-Subscription-Id': args.subscriptionId,
  };
}

// ---------------------------------------------------------------------------
// INBOUND: Netlify's JWS
// ---------------------------------------------------------------------------

/**
 * Verify that a delivery really came from Netlify for this hook.
 *
 * The JWT's signature covers a DIGEST of the body, not the body itself, so a
 * valid signature alone proves nothing about what we received — the digest has
 * to be recomputed from the raw bytes and compared. Both steps are required.
 *
 * Verified manually rather than with a JWT library because the claim set is
 * fixed and tiny, and because we must pin the algorithm to HS256: accepting the
 * header's `alg` would let a caller present `{"alg":"none"}`.
 */
export function verifyNetlifySignature(args: {
  signature: string | null;
  rawBody: string;
  secret: string;
}): boolean {
  if (!args.signature) return false;

  const parts = args.signature.split('.');
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return false;
  }

  // Pin the algorithm; never trust the header's choice.
  if (header?.alg !== 'HS256') return false;

  const expected = createHmac('sha256', args.secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');
  if (!secureEquals(signatureB64, expected)) return false;

  if (payload?.iss !== 'netlify') return false;

  // The signature is only over the digest — bind it to the bytes we actually read.
  const digest = createHash('sha256').update(args.rawBody, 'utf8').digest('hex');
  return typeof payload?.sha256 === 'string' && secureEquals(payload.sha256, digest);
}
