import { EncryptJWT, jwtDecrypt, compactDecrypt } from 'jose'
import type { HandlerEvent, HandlerResponse } from "@netlify/functions";

const JWE_SECRET = process.env.JWE_SECRET || 'mysecrtypekey1234567890123456789012345678901234567890'; // 256-bit key for A256GCM

export function getOAuthIssuer(): string {
  // Use the environment variable or default to localhost
  return process.env.OAUTH_ISSUER || 'http://localhost:8888';
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

export function returnNeedsAuthResponse() {
  return new Response(`{
    "error": "unauthenticated",
    "error_description": "You must authenticate to use this tool"
    }`, {
    status: 401,
    headers: {
        "Content-Type": "application/json",
        // 401s should point to the resource server metadata and that will point to auth endpoints
        "WWW-Authenticate": `Bearer realm="MCP Server", resource_metadata="${getOAuthIssuer()}/.well-known/oauth-protected-resource"`,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': '*',
        'Access-Control-Allow-Headers': '*',
    }
  });
}

export async function createJWE(payload: Record<string, any>, expiresIn: string = '1h'): Promise<string> {
  const password = JWE_SECRET
  const secret = new TextEncoder().encode(password.padEnd(32, '0').slice(0, 32)) // Ensure 32 bytes
  
  const jwe = await new EncryptJWT(payload)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt() // record when the token was minted so expiry can be diagnosed
    .setExpirationTime(expiresIn)
    .encrypt(secret)

  return jwe
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
  const password = JWE_SECRET
  const secret = new TextEncoder().encode(password.padEnd(32, '0').slice(0, 32)) // Ensure 32 bytes

  try {
    const { payload } = await jwtDecrypt(jwe, secret)
    return payload
  } catch (error: any) {
    const log: Record<string, unknown> = {
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
        log.nowEpoch = now;
        log.iat = claims.iat ?? null;
        log.exp = claims.exp ?? null;
        if (typeof claims.exp === 'number') {
          log.expiredBySeconds = now - claims.exp; // negative ⇒ skew (not actually expired)
        }
        if (typeof claims.exp === 'number' && typeof claims.iat === 'number') {
          log.tokenLifetimeSeconds = claims.exp - claims.iat;
          log.ageSeconds = now - claims.iat;
        }
      }
    }

    console.error('Failed to decrypt JWE:', log);
    throw new Error('Invalid JWE token. Please reauthenticate or reconnect to the Netlify MCP server.')
  }
}

