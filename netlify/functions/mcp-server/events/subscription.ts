// Subscription identity for MCP events, with no server-side datastore.
//
// The relay URL we hand to Netlify carries everything the relay needs:
//
//     https://<server>/events/relay/<subId>/<jwe>
//
// `subId` is a deterministic hash of the subscription's identity. It is both the
// `id` we return from `events/subscribe` AND the lookup key we use to find an
// existing hook on Netlify — which is what makes the Netlify hook record itself
// the subscription store. Nothing is persisted here.
//
// `jwe` is the sealed payload: the client's callback URL, the client's signing
// secret, and the shared secret Netlify uses to sign deliveries to us. It is
// encrypted under EVENTS_RELAY_JWE_SECRET — a key of its own, NOT the auth
// JWE_SECRET — so Netlify's database only ever holds ciphertext for third-party
// credentials, and rotating the auth key doesn't silently kill every live
// subscription. Rotating THIS key does invalidate them all, cleanly: the relay
// answers 410 and Netlify deletes the hooks.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createJWE, decryptJWE, getEventsRelayKey, MissingJWEKeyError } from '../utils.ts';

// Relay tokens outlive a refresh cycle several times over so an in-flight
// delivery can never be dropped for staleness, but they do eventually expire:
// once a token is dead the relay answers 410, and Netlify deletes the hook on a
// 410 (Hook#process_http_response). That turns token expiry into automatic
// garbage collection for subscriptions a client stopped refreshing.
export const RELAY_TOKEN_TTL = '30d';
/** How long a subscription is granted before the client must refresh it. */
export const SUBSCRIPTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SubscriptionIdentity {
  /** Netlify user id of the subscriber. Part of the identity: two users watching
   *  the same site must never collide on one hook, or unsubscribing for one
   *  would silently stop delivery for the other. */
  userId: string;
  /** MCP-facing event name, e.g. `deploy.started_failing`. */
  eventName: string;
  siteId: string;
  /** Normalized filter arguments (site already resolved out). */
  filters: EventFilters;
  /** The client's webhook callback URL. */
  callbackUrl: string;
}

export interface EventFilters {
  branch?: string;
  context?: string;
}

export interface RelayToken {
  v: 1;
  subId: string;
  userId: string;
  eventName: string;
  netlifyEvent: string;
  siteId: string;
  filters: EventFilters;
  /** Client callback URL to POST deliveries to. */
  cb: string;
  /** The client's Standard Webhooks signing secret (`whsec_...`). */
  whsec: string;
  /** The secret Netlify signs its deliveries to us with (`x-webhook-signature`). */
  nsec: string;
}

/**
 * Canonical JSON: object keys sorted at every level, `undefined` dropped. The
 * events extension requires comparing subscription arguments "using canonical
 * JSON so object key order does not create duplicate subscriptions" — this is
 * that comparison, and it also makes `subId` stable across clients that
 * serialize params in different orders.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Deterministic subscription id. Same identity in, same id out — which is what
 * makes `events/subscribe` idempotent and makes refresh land on the existing
 * hook instead of creating a second one.
 *
 * Includes `userId` so the id is unique per user, not just per (site, event,
 * callback). Truncated to 32 hex chars: it only needs to be collision-resistant
 * across one user's subscriptions and short enough to keep the relay URL small.
 */
export function computeSubscriptionId(identity: SubscriptionIdentity): string {
  const canonical = canonicalJson({
    v: 1,
    userId: identity.userId,
    eventName: identity.eventName,
    siteId: identity.siteId,
    filters: identity.filters,
    callbackUrl: identity.callbackUrl,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Fresh secret for Netlify to sign its deliveries to the relay with. */
export function generateNetlifySigningSecret(): string {
  return randomBytes(32).toString('base64url');
}

export async function sealRelayToken(token: Omit<RelayToken, 'v'>): Promise<string> {
  return createJWE(
    { ...token, v: 1, token_use: 'mcp_events_relay' },
    RELAY_TOKEN_TTL,
    getEventsRelayKey(),
  );
}

/**
 * The three outcomes of opening a relay token, kept explicit because the relay
 * answers each one differently and two of them look identical if you only have
 * a nullable return:
 *
 *   ok           -> deliver
 *   unreadable   -> 410, which makes Netlify DELETE the hook. Correct for a
 *                   genuinely dead subscription (expired token, rotated key).
 *   misconfigured-> 503. A deployment missing EVENTS_RELAY_JWE_SECRET must NOT
 *                   take the 410 path: that would delete every subscription on
 *                   the platform because of one bad env var.
 */
export type OpenRelayTokenResult =
  | { status: 'ok'; token: RelayToken }
  | { status: 'unreadable' }
  | { status: 'misconfigured'; envVar: string; message: string };

/**
 * Open a relay token.
 *
 * `unreadable` covers anything that does not decrypt to one of ours — an
 * expired token, a token minted under a rotated key, or an unrelated JWE such
 * as a stateless `client_id`. The latter can no longer even decrypt here (it
 * was sealed with the auth key), but the `token_use` discriminator is kept as a
 * second line of defence in case the keys are ever misconfigured to match.
 */
export async function openRelayToken(jwe: string): Promise<OpenRelayTokenResult> {
  let key: Uint8Array;
  try {
    key = getEventsRelayKey();
  } catch (error) {
    if (error instanceof MissingJWEKeyError) {
      return { status: 'misconfigured', envVar: error.envVar, message: error.message };
    }
    throw error;
  }

  try {
    const payload = await decryptJWE(jwe, key) as Record<string, any>;
    if (payload?.token_use !== 'mcp_events_relay' || payload?.v !== 1) {
      return { status: 'unreadable' };
    }
    return { status: 'ok', token: payload as unknown as RelayToken };
  } catch {
    return { status: 'unreadable' };
  }
}

/** Constant-time string compare for secrets and challenge echoes. */
export function secureEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the timing signal does not distinguish
    // "wrong length" from "wrong value".
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** The path the relay is reachable at, for a given subscription. */
export function relayPath(subId: string, jwe: string): string {
  return `/events/relay/${subId}/${jwe}`;
}

/**
 * Parse a relay request path back into its two segments. Returns null when the
 * shape is wrong, so the relay can reject without attempting decryption.
 */
export function parseRelayPath(pathname: string): { subId: string; jwe: string } | null {
  const match = pathname.match(/\/events\/relay\/([0-9a-f]{32})\/([A-Za-z0-9._-]+)\/?$/);
  if (!match) return null;
  return { subId: match[1], jwe: match[2] };
}
