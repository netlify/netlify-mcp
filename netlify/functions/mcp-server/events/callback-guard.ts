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

function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0]; // strip zone id
  if (addr === '::' || addr === '::1') return true;
  if (addr.startsWith('fe8') || addr.startsWith('fe9') ||
      addr.startsWith('fea') || addr.startsWith('feb')) return true; // link-local
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true;   // unique-local
  if (addr.startsWith('ff')) return true;                            // multicast
  // IPv4-mapped (::ffff:a.b.c.d) — defer to the v4 rules.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
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
 * Resolving the name here narrows DNS rebinding but does not close it: the name
 * could resolve differently on the delivery that follows. Full protection needs
 * connect-time pinning, which `fetch` does not expose — so this is a real but
 * partial mitigation, and the reason deliveries also carry no ambient
 * credentials (the only secret on the wire is the client's own signing secret).
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

  // A literal IP in the URL never gets a DNS lookup, so check it directly.
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal)) {
    return isPrivateAddress(literal)
      ? { ok: false, reason: 'private-address', addresses: [literal] }
      : { ok: true, addresses: [literal] };
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
