import { TokenError, verifyToken, type ProxyClaims } from "../functions/mcp-server/tokens.ts";
import { getOAuthStore, OAuthStorageError } from "../functions/mcp-server/oauth-store.ts";
import { log, withLogContext, addLogContext, getRequestId, getDeployId, truncateForLog } from "../functions/mcp-server/logger.ts";
import type {Config, Context} from '@netlify/edge-functions';

// Escape regex metacharacters so an allowed-path template is matched literally
// (except for our own `:param` placeholders, which are substituted afterwards).
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The proxy is called with a proxy token (see tokens.ts) that seals the
// Netlify access token and the exact API calls it may make. It lets us hand a
// short-lived, narrowly scoped credential to something outside the MCP server
// — the CLI deploy command — without ever giving it the Netlify token itself.
export default async (req: Request, ctx: Context) => {
  const token = ctx.params?.token as string;

  // Edge runs in its own isolate, so establish a fresh log context here.
  return withLogContext(
    {
      service: 'proxy',
      requestId: getRequestId(req.headers),
      deployId: getDeployId(req.headers),
      httpMethod: req.method,
      userAgent: truncateForLog(req.headers.get('user-agent')),
    },
    () => handleProxy(req, token),
  );
};

export async function handleProxy(req: Request, token: string): Promise<Response> {
  log.debug('proxy request', { hasToken: !!token, apiPath: token ? req.url.split(token)[1] : undefined });

  if (!token) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Only a proxy token opens this door. An access token, a code, a refresh
  // token or a client registration decrypts under the same key but is a
  // different purpose, and is refused before the request is looked at.
  let claims: ProxyClaims;
  try {
    claims = await verifyToken(token, 'proxy');
  } catch (error) {
    if (error instanceof TokenError) {
      log.warn('proxy token rejected', { reason: error.reason, presented: error.presented });
      return new Response('Unauthorized', { status: 401 });
    }
    throw error;
  }

  // A proxy token minted from an OAuth access token lives up to 30 minutes,
  // so revoking the grant (RFC 7009, a replayed code, a reused refresh token)
  // must end it too. A token minted from a PAT has no grant and is unchanged.
  if (claims.grant) {
    const refusal = await grantRefusal(claims.grant, claims.client_id);
    if (refusal) return refusal;
  }

  // Attribute the proxied call to the user (identity is embedded in the token
  // at issue time; absent on tokens minted from a raw PAT).
  if (claims.identity) {
    addLogContext({ userId: claims.identity.userId, teamId: claims.identity.teamId, grant: claims.grant ?? undefined });
  }

  const requestedPath = req.url.split(token)[1];

  // Normalize BEFORE the allow-list check so we validate exactly what we forward.
  // `new URL` resolves `../` traversal and other WHATWG normalization; matching
  // against the raw string would let a path that merely *contains* the allowed
  // substring (e.g. `.../builds/../../../accounts/TEAM/env`) slip past the check
  // and then normalize to an endpoint the token was never scoped to reach.
  const url = new URL(requestedPath as string, 'https://api.netlify.com');

  if (!url.origin.endsWith('.netlify.com')) {
    log.error('proxy blocked non-Netlify target host', { host: url.host });
    return new Response('Forbidden', { status: 403 });
  }

  const normalizedPath = url.pathname;

  // The allowlist is mandatory (verifyToken refuses a token without one) and
  // is checked against the method actually being forwarded.
  const isAllowed = claims.apisAllowed.some(({ path, method }) => {
    // Escape regex metacharacters in the allowed path, then turn `:param`
    // placeholders into a bounded segment matcher, and anchor with ^...$ so
    // the whole normalized path must match — not just a substring of it.
    const pattern = '^' + escapeRegExp(path).replace(/:\w+/g, '[\\w\\-]+') + '$';
    return new RegExp(pattern).test(normalizedPath) && method.toUpperCase() === req.method.toUpperCase();
  });

  if (!isAllowed) {
    // Expected access-control enforcement (the token requested a path outside
    // its scope), not a server error — warn so it stays a security signal
    // without inflating error metrics.
    log.warn('proxy denied out-of-scope path', { normalizedPath, method: req.method, apisAllowed: claims.apisAllowed });
    return new Response('Forbidden', { status: 403 });
  }

  req.headers.set('Authorization', `Bearer ${claims.accessToken}`);
  req.headers.delete('host');

  const updatedReq = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    redirect: 'manual', // prevent automatic redirects
  });
  log.debug('proxy forwarding', { to: url.toString(), method: updatedReq.method });
  return fetch(updatedReq);
}

async function grantRefusal(grantId: string, clientId: string | null): Promise<Response | null> {
  try {
    const found = await getOAuthStore().getGrant(grantId);
    if (!found || found.record.revoked || found.record.client_id !== clientId) {
      log.warn('proxy token rejected', { reason: !found ? 'grant_missing' : found.record.revoked ? 'grant_revoked' : 'grant_client_mismatch', grant: grantId });
      return new Response('Unauthorized', { status: 401 });
    }
    return null;
  } catch (error) {
    if (error instanceof OAuthStorageError) {
      log.error('proxy grant store unavailable', { grant: grantId, err: error });
      return new Response('Authorization store unavailable; retry shortly', { status: 503, headers: { 'Retry-After': '5' } });
    }
    throw error;
  }
}

export const config: Config = {
  path: '/proxy/:token/*'
};
