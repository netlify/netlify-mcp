// SSRF guard and callback verification for the one place this server makes an
// outbound request to a URL a caller chose: the events callback.
//
// This is deliberately NOT built on `src/tools/design-import/url-guard.ts`. That
// guard is a host allowlist, which works because design imports only ever fetch
// claude.ai. A webhook callback host cannot be allowlisted, so this guard has to
// do the thing an allowlist lets you skip: resolve the name and reject private
// address space. The extension's requirements are explicit — "Enforce HTTPS;
// block private/local addresses; do not follow redirects."

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { log } from '../logger.ts';
import { secureEquals } from './subscription.ts';
import { signOutboundDelivery } from './signing.ts';

export type CallbackRejection =
  | 'not-a-url'
  | 'not-https'
  | 'has-credentials'
  | 'unresolvable'
  | 'ip-literal'
  | 'private-address';

export interface CallbackCheck {
  ok: boolean;
  reason?: CallbackRejection;
  /** Addresses the hostname resolved to, for logging. */
  addresses?: string[];
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable: fail closed
  }
  const [a, b] = parts;
  if (a === 0) return true;                        // "this network"
  if (a === 10) return true;                       // RFC 1918
  if (a === 127) return true;                      // loopback
  if (a === 169 && b === 254) return true;         // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true;         // RFC 1918
  if (a === 192 && b === 0) return true;           // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true;                       // multicast + reserved
  return false;
}

/**
 * IPv6, by allowlist rather than by enumerating the private ranges.
 *
 * Only global unicast (2000::/3) is public, so everything else — `::1`,
 * `fe80::/10`, `fc00::/7`, multicast, `::ffff:`-mapped v4, NAT64 — is private by
 * default with no parsing required. The one carve-out inside 2000::/3 is
 * 6to4 (2002::/16), which embeds an arbitrary IPv4 address.
 *
 * Fails closed: anything we cannot read the leading hextet of is private.
 */
function isPrivateIPv6(ip: string): boolean {
  const first = ip.toLowerCase().split('%')[0].split(':')[0];
  // A leading '::' yields an empty group, which is correctly not global unicast.
  const leading = first === '' ? 0 : Number.parseInt(first, 16);
  if (!Number.isInteger(leading)) return true;

  const globalUnicast = leading >= 0x2000 && leading <= 0x3fff;
  if (!globalUnicast) return true;
  if (leading === 0x2002) return true; // 6to4 tunnels an IPv4 address
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // not an IP at all: fail closed
}

/**
 * Check a client-supplied callback URL before we ever send to it.
 *
 * What stops a request being redirected somewhere else after it is vetted:
 *
 *  - The destination is immutable. It is sealed in the relay token under
 *    AES-256-GCM and bound into `subId`, so it cannot be read, edited or
 *    replayed against another subscription, and the relay only ever connects
 *    to `token.cb` — never to anything the inbound request supplies.
 *  - HTTP redirects are refused, not followed (`redirect: 'error'`), on both
 *    the handshake and every delivery.
 *  - IP literals are refused outright, so there is no second spelling of an
 *    address to get right.
 *  - This check re-runs on every delivery, not just at subscribe.
 *
 * What remains is DNS rebinding: the name is resolved here and again by
 * `fetch`, so a record that changes in between could point elsewhere. Closing
 * that needs connect-time address pinning, which is a deliberate non-goal —
 * pinning an IP breaks ordinary DNS-based failover and load balancing for every
 * honest subscriber. The exposure is bounded instead: HTTPS means the
 * destination still has to present a valid certificate for the vetted
 * hostname, and deliveries carry no ambient credentials — the only secret on
 * the wire is the subscriber's own signing secret, which is useless to anyone
 * else.
 */
export async function checkCallbackUrl(rawUrl: string): Promise<CallbackCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'not-a-url' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'not-https' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'has-credentials' };
  }

  // Callbacks must be hostnames, not IP literals. A real subscriber always has
  // a DNS name, and refusing literals outright is both simpler and safer than
  // vetting them: WHATWG `URL` rewrites an IPv6 host into its compressed
  // hexadecimal form (`[::ffff:127.0.0.1]` becomes `::ffff:7f00:1`), so any
  // literal-matching scheme has a second spelling of every address to get
  // right. IPs reached via DNS are still checked below.
  if (isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
    return { ok: false, reason: 'ip-literal' };
  }

  let addresses: string[];
  try {
    const results = await lookup(url.hostname, { all: true });
    addresses = results.map((r) => r.address);
  } catch {
    return { ok: false, reason: 'unresolvable' };
  }

  if (addresses.length === 0) {
    return { ok: false, reason: 'unresolvable' };
  }
  // Every address must be public: a hostname with one public and one private A
  // record would otherwise be a coin flip.
  if (addresses.some(isPrivateAddress)) {
    return { ok: false, reason: 'private-address', addresses };
  }

  return { ok: true, addresses };
}

/**
 * Perform the callback verification handshake required before delivery may
 * start. We POST a single-use challenge, signed the same way real deliveries
 * are, and the client must echo it back with a 2xx.
 */
export async function verifyCallbackUrl(args: {
  callbackUrl: string;
  secret: string;
  subscriptionId: string;
  challenge: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; reason?: CallbackRejection | 'bad-status' | 'challenge-mismatch' | 'unreachable' }> {
  const guard = await checkCallbackUrl(args.callbackUrl);
  if (!guard.ok) {
    log.warn('events callback rejected by guard', {
      reason: guard.reason,
      subscriptionId: args.subscriptionId,
    });
    return { ok: false, reason: guard.reason };
  }

  const body = JSON.stringify({ type: 'verification', challenge: args.challenge });
  // A distinct id for the verification message, as the extension's example does
  // (`msg_verification_123`) — it must not collide with a real event id.
  const headers = signOutboundDelivery({
    eventId: `msg_verification_${args.subscriptionId}`,
    subscriptionId: args.subscriptionId,
    body,
    secret: args.secret,
  });
  if (!headers) {
    return { ok: false, reason: 'not-a-url' };
  }

  let response: Response;
  try {
    response = await fetch(args.callbackUrl, {
      method: 'POST',
      headers,
      body,
      redirect: 'error', // never follow a redirect off the vetted host
      signal: AbortSignal.timeout(args.timeoutMs ?? 10_000),
    });
  } catch (error) {
    log.warn('events callback verification unreachable', {
      subscriptionId: args.subscriptionId,
      err: error,
    });
    return { ok: false, reason: 'unreachable' };
  }

  if (!response.ok) {
    return { ok: false, reason: 'bad-status' };
  }

  let echoed: unknown;
  try {
    echoed = (await response.json() as Record<string, unknown>)?.challenge;
  } catch {
    return { ok: false, reason: 'challenge-mismatch' };
  }

  if (typeof echoed !== 'string' || !secureEquals(echoed, args.challenge)) {
    return { ok: false, reason: 'challenge-mismatch' };
  }

  return { ok: true };
}
