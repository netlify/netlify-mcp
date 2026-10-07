import { EncryptJWT, jwtDecrypt, compactDecrypt } from 'jose'
import type { HandlerEvent, HandlerResponse } from "@netlify/functions";
import { log } from "./logger.ts";

// The symmetric key that encrypts AND validates every token this server issues
// (OAuth access/refresh tokens, the authorization code, and the /proxy/:token
// JWE that carries the raw Netlify token). Whoever knows this key can both
// decrypt intercepted tokens and forge new ones the server accepts, so a real
// deployment MUST set a strong JWE_SECRET — we fail closed otherwise.
//
// The one exception is local development (a localhost issuer), where a fixed
// dev key keeps `netlify dev` zero-config AND lets the separate edge-function
// and serverless-function runtimes share a key. That key is intentionally
// inert: it only activates on localhost, so it grants nothing on a deployed
// instance even though it lives in the repo.
//
// There are TWO independent keys, deliberately:
//
//   JWE_SECRET               — auth: OAuth access/refresh tokens, the
//                              authorization code, the stateless DCR client_id,
//                              and the /proxy/:token JWE.
//   EVENTS_RELAY_JWE_SECRET  — event notification relay tokens only.
//
// Separated so the two rotation levers don't collide. Rotating JWE_SECRET is the
// revocation lever for client registrations and tokens, and it has to stay
// usable on its own terms — but it would otherwise also make every live event
// subscription's relay token unreadable, silently killing customer
// notifications. With separate keys, each can be rotated without touching the
// other.
const MIN_JWE_SECRET_LENGTH = 32; // 256 bits, the key size A256GCM requires
const DEV_ONLY_LOCALHOST_KEY = 'dev-only-insecure-localhost-key-not-for-production-use';
// A DIFFERENT dev key, so local development exercises the separation too: a
// token minted for one purpose must not open with the other's key. The
// difference has to fall inside the first 32 characters, because deriveKey()
// truncates there — 'events-relay-' leads for exactly that reason.
const DEV_ONLY_LOCALHOST_EVENTS_KEY = 'events-relay-dev-only-insecure-localhost-key-not-for-production-use';

/**
 * Thrown when a required JWE key is absent. Distinct from a decryption failure
 * on purpose: callers must be able to tell "this deployment is misconfigured"
 * (retryable, operator-fixable) from "this token is not valid" (terminal). The
 * events relay depends on that distinction — it answers a bad token with 410,
 * which makes Netlify DELETE the hook, so a missing key must never take that
 * path or one misconfigured deploy would wipe every subscription.
 */
export class MissingJWEKeyError extends Error {
  readonly envVar: string;
  constructor(envVar: string, message: string) {
    super(message);
    this.name = 'MissingJWEKeyError';
    this.envVar = envVar;
  }
}

let cachedSecretKey: Uint8Array | null = null;
let cachedEventsKey: Uint8Array | null = null;
let warnedAboutDevKey = false;
let warnedAboutEventsDevKey = false;

/**
 * True when the server is running against a localhost issuer (i.e. `netlify
 * dev`), where a default key is acceptable because nothing is exposed.
 */
function isLocalIssuer(): boolean {
  const issuer = process.env.OAUTH_ISSUER;
  if (!issuer) {
    return true; // getOAuthIssuer() defaults to http://localhost:8888
  }
  try {
    const host = new URL(issuer).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function getSecretKey(): Uint8Array {
  if (cachedSecretKey) {
    return cachedSecretKey;
  }

  let password = process.env.JWE_SECRET;

  if (!password) {
    if (!isLocalIssuer()) {
      // Fail closed on a real deployment rather than fall back to a key that
      // would be public in this repository.
      throw new Error(
        'JWE_SECRET is not set. Refusing to issue or accept tokens with a default key. ' +
        `Set JWE_SECRET to a random secret of at least ${MIN_JWE_SECRET_LENGTH} characters (e.g. \`openssl rand -base64 48\`).`,
      );
    }
    if (!warnedAboutDevKey) {
      log.warn(
        '[JWE] JWE_SECRET is not set — using an insecure dev-only key because the issuer is localhost. ' +
        'NEVER run a deployed instance without a strong JWE_SECRET.',
      );
      warnedAboutDevKey = true;
    }
    password = DEV_ONLY_LOCALHOST_KEY;
  } else if (password.length < MIN_JWE_SECRET_LENGTH) {
    throw new Error(
      `JWE_SECRET is too short (${password.length} chars). It must be at least ${MIN_JWE_SECRET_LENGTH} characters (256 bits).`,
    );
  }

  cachedSecretKey = deriveKey(password);
  return cachedSecretKey;
}

/** A256GCM needs exactly 32 bytes. */
function deriveKey(password: string): Uint8Array {
  return new TextEncoder().encode(password.padEnd(32, '0').slice(0, 32));
}

/**
 * Whether event subscriptions can work on this deployment at all.
 *
 * Used to decide whether to ADVERTISE the events capability: offering
 * subscriptions that are guaranteed to fail is worse than not offering them, so
 * a deployment without the relay key simply looks like a server without events.
 */
export function isEventsRelayConfigured(): boolean {
  try {
    getEventsRelayKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * The key that seals event-notification relay tokens.
 *
 * Kept separate from `getSecretKey()` so the events feature has its own
 * rotation lever (see the note at the top of this file). Rotating this one
 * invalidates every live subscription's relay token — the relay then answers
 * 410 and Netlify deletes the hooks, so subscriptions are cleanly torn down
 * rather than left firing into the void, but clients must re-subscribe.
 */
export function getEventsRelayKey(): Uint8Array {
  if (cachedEventsKey) {
    return cachedEventsKey;
  }

  let password = process.env.EVENTS_RELAY_JWE_SECRET;

  if (!password) {
    if (!isLocalIssuer()) {
      // Fail closed, and fail LOUD — but only for the events feature. The rest
      // of the server is unaffected by this key being absent.
      throw new MissingJWEKeyError(
        'EVENTS_RELAY_JWE_SECRET',
        'EVENTS_RELAY_JWE_SECRET is not set, so event notification subscriptions ' +
        'cannot be created or delivered. Set it to a random secret of at least ' +
        `${MIN_JWE_SECRET_LENGTH} characters (e.g. \`openssl rand -base64 48\`). ` +
        'It MUST be different from JWE_SECRET so the two can be rotated independently.',
      );
    }
    if (!warnedAboutEventsDevKey) {
      log.warn(
        '[JWE] EVENTS_RELAY_JWE_SECRET is not set — using an insecure dev-only key because ' +
        'the issuer is localhost. NEVER run a deployed instance without a strong key.',
      );
      warnedAboutEventsDevKey = true;
    }
    password = DEV_ONLY_LOCALHOST_EVENTS_KEY;
  } else if (password.length < MIN_JWE_SECRET_LENGTH) {
    throw new MissingJWEKeyError(
      'EVENTS_RELAY_JWE_SECRET',
      `EVENTS_RELAY_JWE_SECRET is too short (${password.length} chars). It must be at least ${MIN_JWE_SECRET_LENGTH} characters (256 bits).`,
    );
  }

  const derived = deriveKey(password);

  // Compare the DERIVED keys, not the raw strings. deriveKey() truncates to the
  // first 32 characters, so two secrets that merely share a 32-char prefix
  // collapse to the same key — a string comparison would wave that through and
  // the two rotation levers would still be coupled, just invisibly.
  const authSecret = process.env.JWE_SECRET;
  if (authSecret && Buffer.from(derived).equals(Buffer.from(deriveKey(authSecret)))) {
    throw new MissingJWEKeyError(
      'EVENTS_RELAY_JWE_SECRET',
      'EVENTS_RELAY_JWE_SECRET derives to the same key as JWE_SECRET (note that only the ' +
      'first 32 characters are used, so a shared prefix is enough to collide). The point ' +
      'of the separate key is that either can be rotated without invalidating the other.',
    );
  }

  cachedEventsKey = derived;
  return cachedEventsKey;
}

export function getOAuthIssuer(): string {
  const raw = process.env.OAUTH_ISSUER || 'http://localhost:8888';
  // Canonicalize so the issuer string is byte-identical everywhere it's used.
  // The AS/PRM metadata documents pass through urlsToHTTP(), which normalizes
  // every URL via `new URL().toString()` — and WHATWG URL appends a trailing
  // slash to a bare origin (https://host -> https://host/). The RFC 9207 `iss`
  // authorization-response param MUST byte-match the advertised `issuer`, so we
  // normalize here rather than emit the raw env value (which lacked the slash
  // and made strict clients like Codex reject the callback). Idempotent, and a
  // no-op for issuers that already include a path or trailing slash.
  try {
    return new URL(raw).toString();
  } catch {
    return raw;
  }
}

export function addCommonHeadersToHandlerResp(response: HandlerResponse): HandlerResponse {
  const respHeaders = headersToHeadersObject(response.headers as Record<string, string> | Headers || {});
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('Access-Control-Allow-Methods', '*');
  respHeaders.set('Access-Control-Allow-Headers', '*');

  if(response.statusCode === 200 && response.body) {
    if(['{', '['].includes(response.body.trim().charAt(0))) {
      respHeaders.set('Content-type', 'application/json');
    }
  }

  response.headers = Object.fromEntries(respHeaders.entries());
  return response;
}

export function addCORSHeadersToFetchResp(response: Response): Response {
  const respHeaders = headersToHeadersObject(response.headers as Record<string, string> | Headers || {});
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('Access-Control-Allow-Methods', '*');
  respHeaders.set('Access-Control-Allow-Headers', '*');

  const newResp = new Response(response.body, {
    status: response.status,
    headers: {
      ...Object.fromEntries(response.headers.entries()),
      ...Object.fromEntries(respHeaders.entries())
    }
  });

  return newResp;
}

export function headersToHeadersObject(headers: Headers | Record<string, string>): Headers {
  const headersObj = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string' || typeof value === 'number') {
      headersObj.set(key, value.toString());
    }
  }
  return headersObj;
}

export function getParsedUrl(req: HandlerEvent, overrideUrl?: string): URL {
  return new URL(overrideUrl ?? req.rawUrl, getOAuthIssuer() || 'https://unknown.example.com');
}

export function urlsToHTTP(payload: Record<string, any> | string, origin: string): Record<string, any> | string {
  let text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const {host: targetHost, origin: targetOrigin} = new URL(origin);
  text = text.replace(/(https?:\/\/[^"]+)/g, (match, url) => {

    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.origin.endsWith(targetHost)) {
        return parsedUrl.toString().replace(parsedUrl.origin, targetOrigin);
      }
    } catch {}
    return match; // Return original match if not valid or not same origin
  });
  return typeof payload === 'string' ? text : JSON.parse(text);
}

/**
 * 401 challenge per MCP auth spec (RFC 9728 §5.1 + OAuth 2.1 §5.3 / RFC 6750).
 * Pass `error: 'invalid_token'` when a token WAS presented but failed validation
 * (expired/invalid) so clients can refresh; omit it when no token was sent so the
 * client knows to start a fresh authorization flow.
 */
export function returnNeedsAuthResponse(opts?: { error?: string; errorDescription?: string }) {
  // RFC 9728 §5.1: point at the metadata for THIS resource (the MCP server at /mcp).
  const resourceMetadata = new URL('/.well-known/oauth-protected-resource/mcp', getOAuthIssuer()).toString();

  const challenge = ['realm="MCP Server"'];
  if (opts?.error) {
    challenge.push(`error="${opts.error}"`);
    if (opts.errorDescription) {
      challenge.push(`error_description="${opts.errorDescription}"`);
    }
  }
  challenge.push(`resource_metadata="${resourceMetadata}"`);

  return new Response(JSON.stringify({
    error: opts?.error || 'unauthenticated',
    error_description: opts?.errorDescription || 'You must authenticate to use this tool',
  }), {
    status: 401,
    headers: {
        "Content-Type": "application/json",
        // 401s point to the resource server metadata, which points to the auth server
        "WWW-Authenticate": `Bearer ${challenge.join(', ')}`,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': '*',
        'Access-Control-Allow-Headers': '*',
    }
  });
}

/**
 * The OAuth and proxy JWEs carry a `token_use` naming their purpose, and every
 * endpoint that grants access on one checks it. They all decrypt with the same
 * key, so without it an authorization code, a refresh token or a proxy token
 * each opened /mcp as if it were an access token.
 */
export const TOKEN_USE = {
  authorizationRequest: 'authorization_request',
  authorizationCode: 'authorization_code',
  access: 'access',
  refresh: 'refresh',
  proxy: 'proxy',
} as const;

/**
 * Encrypt a payload as a JWE. `expiresIn` accepts any `jose` duration string
 * (e.g. '1h', '7d'); pass `null` to mint a token with NO expiry — used for the
 * stateless dynamic-client-registration `client_id`, which encodes the client's
 * metadata and must remain valid for the life of the registration (revocation is
 * via JWE_SECRET rotation, which invalidates all registrations at once).
 */
export async function createJWE(
  payload: Record<string, any>,
  expiresIn: string | null = '1h',
  key?: Uint8Array,
): Promise<string> {
  const secret = key ?? getSecretKey()

  const builder = new EncryptJWT(payload)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt() // record when the token was minted so expiry can be diagnosed

  if (expiresIn !== null) {
    builder.setExpirationTime(expiresIn)
  }

  return builder.encrypt(secret)
}

/**
 * Decode a JWE's claims WITHOUT validating exp/nbf. Used only for diagnostics so
 * we can report when a token was issued and by how much it's expired. Never use
 * the result for auth decisions — it bypasses claim validation.
 */
async function peekClaims(jwe: string, secret: Uint8Array): Promise<Record<string, any> | null> {
  try {
    const { plaintext } = await compactDecrypt(jwe, secret);
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}

export async function decryptJWE(jwe: string, key?: Uint8Array) {
  const secret = key ?? getSecretKey()

  try {
    const { payload } = await jwtDecrypt(jwe, secret)
    return payload
  } catch (error: any) {
    const errorDetails: Record<string, unknown> = {
      message: error?.message || '',
      reason: error?.reason || '',
      code: error?.code || '',
      claim: error?.claim || '',
    };

    // On an expiry failure, decode the (unvalidated) claims so we can see when
    // the token was issued and by how much it's "expired" — this surfaces clock
    // skew, where a just-minted token is rejected as already expired.
    if (error?.code === 'ERR_JWT_EXPIRED') {
      const claims = await peekClaims(jwe, secret);
      const now = Math.floor(Date.now() / 1000);
      if (claims) {
        errorDetails.nowEpoch = now;
        errorDetails.iat = claims.iat ?? null;
        errorDetails.exp = claims.exp ?? null;
        if (typeof claims.exp === 'number') {
          errorDetails.expiredBySeconds = now - claims.exp; // negative ⇒ skew (not actually expired)
        }
        if (typeof claims.exp === 'number' && typeof claims.iat === 'number') {
          errorDetails.tokenLifetimeSeconds = claims.exp - claims.iat;
          errorDetails.ageSeconds = now - claims.iat;
        }
      }
    }

    const isRoutineExpiry = error?.code === 'ERR_JWT_EXPIRED'
      && typeof errorDetails.expiredBySeconds === 'number'
      && errorDetails.expiredBySeconds >= 0;
    log[isRoutineExpiry ? 'warn' : 'error']('Failed to decrypt JWE', errorDetails);
    throw new Error('Invalid JWE token. Please reauthenticate or reconnect to the Netlify MCP server.')
  }
}

