import { EncryptJWT, jwtDecrypt } from 'jose'
import type { HandlerEvent, HandlerResponse } from "@netlify/functions";

const JWE_SECRET = process.env.JWE_SECRET || 'mysecrtypekey1234567890123456789012345678901234567890'; // 256-bit key for A256GCM

export function getOAuthIssuer(): string {
  // Use the environment variable or default to localhost
  return process.env.OAUTH_ISSUER || 'http://localhost:8888';
}

export function addCORSHeaders(response: HandlerResponse): HandlerResponse {
  const respHeaders = headersToHeadersObject(response.headers as Record<string, string> | Headers || {});
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('Access-Control-Allow-Methods', '*');
  respHeaders.set('Access-Control-Allow-Headers', '*');
  response.headers = Object.fromEntries(respHeaders.entries());
  return response;
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
        "WWW-Authenticate": `Bearer resource_metadata="${getOAuthIssuer()}/.well-known/oauth-protected-resource"`,
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
    .setExpirationTime(expiresIn)
    .encrypt(secret)
  
  return jwe
}

export async function decryptJWE(jwe: string) {
  const password = JWE_SECRET
  const secret = new TextEncoder().encode(password.padEnd(32, '0').slice(0, 32)) // Ensure 32 bytes

  try {
    const { payload } = await jwtDecrypt(jwe, secret)
    return payload
  } catch (error) {
    console.error('Failed to decrypt JWE:', error)
    throw new Error('Invalid JWE token')
  }
}

