import { decryptJWE } from "../functions/mcp-server/utils.ts";
import { log, withLogContext, addLogContext, getRequestId, getDeployId } from "../functions/mcp-server/logger.ts";
import type {Config, Context} from '@netlify/edge-functions';

// Escape regex metacharacters so an allowed-path template is matched literally
// (except for our own `:param` placeholders, which are substituted afterwards).
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The proxy is called with a JWE that has a accessToken inside.
// This is to allow us to give a short lived token to something external to
// the MCP server and use it to enrich requests
export default async (req: Request, ctx: Context) => {
  const token = ctx.params?.token as string;

  // Edge runs in its own isolate, so establish a fresh log context here.
  return withLogContext(
    {
      service: 'proxy',
      requestId: getRequestId(req.headers),
      deployId: getDeployId(req.headers),
      httpMethod: req.method,
      userAgent: req.headers.get('user-agent') ?? undefined,
    },
    () => handleProxy(req, token),
  );
};

export async function handleProxy(req: Request, token: string): Promise<Response> {
  log.debug('proxy request', { hasToken: !!token, apiPath: token ? req.url.split(token)[1] : undefined });

  if (!token) {
    return new Response('Unauthorized', { status: 401 });
  }
  let decryptedToken: Record<string, any> | undefined;
  try {
    decryptedToken = await decryptJWE(token);
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!decryptedToken || typeof decryptedToken.accessToken !== 'string') {
    return new Response('Unauthorized', { status: 401 });
  }

  // Attribute the proxied call to the user (identity is embedded in the JWE at
  // token-issue time; absent on raw PATs and pre-identity tokens).
  if (decryptedToken.identity && typeof decryptedToken.identity === 'object') {
    const { userId, teamId } = decryptedToken.identity as { userId?: string; teamId?: string };
    addLogContext({ userId, teamId });
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

  if (Array.isArray(decryptedToken.apisAllowed)) {
    const isAllowed = decryptedToken.apisAllowed.some(({ path, method }: { path: string; method: string; }) => {
      // Escape regex metacharacters in the allowed path, then turn `:param`
      // placeholders into a bounded segment matcher, and anchor with ^...$ so
      // the whole normalized path must match — not just a substring of it.
      const pattern = '^' + escapeRegExp(path).replace(/:\w+/g, '[\\w\\-]+') + '$';
      const pathMatches = new RegExp(pattern).test(normalizedPath);
      return pathMatches && method === req.method;
    });

    if (!isAllowed) {
      // Expected access-control enforcement (the token requested a path outside
      // its scope), not a server error — warn so it stays a security signal
      // without inflating error metrics.
      log.warn('proxy denied out-of-scope path', { normalizedPath, apisAllowed: decryptedToken.apisAllowed });
      return new Response('Forbidden', { status: 403 });
    }
  }

  req.headers.set('Authorization', `Bearer ${decryptedToken.accessToken}`);
  req.headers.delete('host');

  const updatedReq = new Request(url, {
    method: decryptedToken.apiMethod as string | undefined || req.method,
    headers: req.headers,
    body: req.body,
    redirect: 'manual', // prevent automatic redirects
  });
  log.debug('proxy forwarding', { to: url.toString(), method: updatedReq.method });
  return fetch(updatedReq);
}

export const config: Config = {
  path: '/proxy/:token/*'
};
