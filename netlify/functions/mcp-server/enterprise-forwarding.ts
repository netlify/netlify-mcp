import type { HandlerResponse } from '@netlify/functions';
import { createJWE } from './utils.ts';

interface ForwardingOptions {
  readonly endpoint: string;
  readonly resource: string;
  readonly fetchToken?: typeof fetch;
}

function response(statusCode: number, body: Record<string, unknown>, headers: Record<string, string> = {}): HandlerResponse {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Pragma': 'no-cache', ...headers }, body: JSON.stringify(body) };
}

// BitBalloon authenticates Claude and verifies the original assertion. This
// endpoint is trusted deployment configuration, never a request parameter.
export async function forwardEnterpriseGrant(req: Request, body: string, { endpoint, resource, fetchToken = fetch }: ForwardingOptions): Promise<HandlerResponse> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return response(503, { error: 'temporarily_unavailable' });
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    return response(503, { error: 'temporarily_unavailable' });
  }
  if (req.method !== 'POST') return response(405, { error: 'invalid_request' });

  const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' });
  const authorization = req.headers.get('authorization');
  if (authorization) headers.set('Authorization', authorization);

  // Starting the clock before the network call conservatively bounds the
  // wrapper even when BitBalloon's response takes time to arrive.
  const startedAt = Math.floor(Date.now() / 1000);
  try {
    const upstream = await fetchToken(url, { method: 'POST', body, headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const result: unknown = await upstream.json();
    if (!result || typeof result !== 'object' || Array.isArray(result)) return response(502, { error: 'server_error' });
    const token = result as Record<string, unknown>;
    if (upstream.status === 400 || upstream.status === 401 || upstream.status === 403 || upstream.status === 429) {
      const errors = ['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope', 'invalid_target', 'temporarily_unavailable', 'insufficient_user_authentication'];
      const challenge = upstream.status === 401 ? upstream.headers.get('www-authenticate') : null;
      return typeof token.error === 'string' && errors.includes(token.error)
        ? response(upstream.status, { error: token.error }, challenge ? { 'WWW-Authenticate': challenge } : {})
        : response(502, { error: 'server_error' });
    }
    if (upstream.status !== 200 || typeof token.access_token !== 'string' || !token.access_token ||
        typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer' ||
        typeof token.expires_in !== 'number' || !Number.isSafeInteger(token.expires_in) || token.expires_in <= 0 ||
        token.resource !== resource || typeof token.scope !== 'string' || !token.scope || 'refresh_token' in token) {
      return response(502, { error: 'server_error' });
    }
    const expiresAt = startedAt + token.expires_in;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return response(502, { error: 'server_error' });
    const accessToken = await createJWE({ accessToken: token.access_token, type: 'ema', resource, scope: token.scope }, expiresAt);
    const expiresIn = expiresAt - Math.floor(Date.now() / 1000);
    if (expiresIn <= 0) return response(502, { error: 'server_error' });
    return response(200, { access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn, resource, scope: token.scope });
  } catch {
    // Network and parse errors can contain the request URL or proof material.
    return response(502, { error: 'server_error' });
  }
}
