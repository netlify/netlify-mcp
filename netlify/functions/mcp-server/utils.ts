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
const MIN_JWE_SECRET_LENGTH = 32; // 256 bits, the key size A256GCM requires
const DEV_ONLY_LOCALHOST_KEY = 'dev-only-insecure-localhost-key-not-for-production-use';

let cachedSecretKey: Uint8Array | null = null;
let warnedAboutDevKey = false;

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

  cachedSecretKey = new TextEncoder().encode(password.padEnd(32, '0').slice(0, 32)); // A256GCM needs exactly 32 bytes
  return cachedSecretKey;
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
 * Encrypt a payload as a JWE. `expiresIn` accepts any `jose` duration string
 * (e.g. '1h', '7d'); pass `null` to mint a token with NO expiry — used for the
 * stateless dynamic-client-registration `client_id`, which encodes the client's
 * metadata and must remain valid for the life of the registration (revocation is
 * via JWE_SECRET rotation, which invalidates all registrations at once).
 */
export async function createJWE(payload: Record<string, any>, expiresIn: string | null = '1h'): Promise<string> {
  const secret = getSecretKey()

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

export async function decryptJWE(jwe: string) {
  const secret = getSecretKey()

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

    // Genuine expiry is routine (handled as 401 upstream) — warn. Everything
    // else (clock skew, wrong key, malformed) stays error.
    const isRoutineExpiry = error?.code === 'ERR_JWT_EXPIRED'
      && typeof errorDetails.expiredBySeconds === 'number'
      && errorDetails.expiredBySeconds >= 0;
    log[isRoutineExpiry ? 'warn' : 'error']('Failed to decrypt JWE', errorDetails);
    throw new Error('Invalid JWE token. Please reauthenticate or reconnect to the Netlify MCP server.')
  }
}

