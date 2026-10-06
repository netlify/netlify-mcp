import type { Config, Context, HandlerResponse } from "@netlify/functions";
import {
  handleAuthStart,
  handleClientRegistration,
  handleClientSideAuthExchange,
  handleCodeExchange,
  handleConsentDecision,
  handleConsentPage,
  handleRevocation,
  handleServerSideAuthRedirect,
} from "./mcp-server/auth-flow.ts";
import { buildAuthServerMetadata, buildProtectedResourceMetadata } from "./mcp-server/metadata.ts";
import { SUPPORTED_SCOPES, OAUTH_ROUTES } from "./mcp-server/oauth-config.ts";
import { addCommonHeadersToHandlerResp } from "./mcp-server/utils.ts";
import { safeBodySummary } from "./mcp-server/logging.ts";
import { log, withLogContext, getRequestId, initLogger, getDeployId, truncateForLog } from "./mcp-server/logger.ts";
import { systemLogForwarder } from "./mcp-server/system-log-forwarder.ts";
import { installProcessGuards } from "./mcp-server/process-guards.ts";

// Route structured logs onto Netlify's system-log channel for this Node
// function. Runs once at cold start; edge/CLI keep the default console forwarder.
initLogger({ forward: systemLogForwarder });

// Keep detached transient network errors (background keep-alive socket resets)
// from crashing the function as opaque "Invoke Error"s. Runs once at cold start.
installProcessGuards();

/**
 * Plain OAuth 2.1 Authorization Server for MCP.
 *
 * This is a hand-built router — there is no OIDC library underneath. The server
 * fronts Netlify's own OAuth: the human authenticates at app.netlify.com and we
 * wrap the resulting token in a JWE. All real logic lives in the mcp-server/
 * handlers (auth-flow.ts, client-registry.ts); this file only dispatches.
 *
 * We implement and advertise ONLY the MCP-required surface:
 *   - RFC 9728 protected-resource metadata
 *   - RFC 8414 authorization-server metadata
 *   - RFC 7591 dynamic client registration
 *   - OAuth 2.1 authorization + token endpoints (PKCE S256 required)
 *   - RFC 7009 revocation
 * There is deliberately no introspection / userinfo / jwks / device-flow / PAR
 * endpoint; any other path returns a clean 404.
 */

function jsonResponse(statusCode: number, body: unknown): HandlerResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function oAuthHandler(reqObj: Request): Promise<HandlerResponse> {
  log.debug('oauth request', { url: reqObj.url });

  // Handle CORS preflight requests
  if (reqObj.method === 'OPTIONS') {
    return {
      statusCode: 204,
      body: '',
    };
  }

  const pathname = new URL(reqObj.url).pathname;

  // RFC 9728 Protected Resource Metadata. Clients derive the PRM URL from the
  // resource path, so for a resource at /mcp they request
  // /.well-known/oauth-protected-resource/mcp. Match both that path-based form
  // and the bare well-known path.
  if (pathname.includes('/.well-known/oauth-protected-resource')) {
    return jsonResponse(200, buildProtectedResourceMetadata());
  }

  // RFC 8414 Authorization Server Metadata. Also served at the OIDC
  // openid-configuration path as a compatibility alias: some MCP clients probe
  // that path first even though this is a plain OAuth 2.1 AS (it issues no
  // id_token). Both return the same document.
  if (
    pathname.endsWith('/.well-known/oauth-authorization-server') ||
    pathname.endsWith('/.well-known/openid-configuration')
  ) {
    return jsonResponse(200, buildAuthServerMetadata());
  }

  // Dynamic Client Registration (RFC 7591), stateless: the returned client_id is
  // a JWE of the client metadata (see auth-flow / client-registry), so nothing
  // is persisted. Some clients POST to the conventional /register path instead
  // of the advertised registration_endpoint; accept both.
  const isRegistration = pathname.endsWith(OAUTH_ROUTES.registration) || pathname.endsWith('/register');
  if (isRegistration && reqObj.method === 'POST') {
    log.debug('registration request', { body: safeBodySummary(await reqObj.clone().text()) });
    return await handleClientRegistration(reqObj, SUPPORTED_SCOPES);
  }

  // The interactive authorization flow, handled directly: /auth records the
  // request and shows consent; consent approval sends the browser to Netlify;
  // Netlify returns to client-redirect, which posts the token to
  // server-redirect, which mints the code.
  if (pathname.endsWith(OAUTH_ROUTES.authorization)) {
    return await handleAuthStart(reqObj);
  }
  if (pathname.endsWith(OAUTH_ROUTES.consent)) {
    if (reqObj.method === 'POST') {
      return await handleConsentDecision(reqObj);
    }
    return await handleConsentPage(reqObj);
  }
  if (pathname.endsWith(OAUTH_ROUTES.clientRedirect)) {
    return await handleClientSideAuthExchange();
  }
  if (pathname.endsWith(OAUTH_ROUTES.serverRedirect)) {
    return await handleServerSideAuthRedirect(reqObj);
  }
  if (pathname.endsWith(OAUTH_ROUTES.token)) {
    return await handleCodeExchange(reqObj);
  }
  if (pathname.endsWith(OAUTH_ROUTES.revocation) && reqObj.method === 'POST') {
    return await handleRevocation(reqObj);
  }

  // No other OAuth endpoints exist on this server. Return a clean OAuth-style
  // error rather than letting the request fall through to a generic 404 page.
  log.warn('oauth: unknown endpoint');
  return jsonResponse(404, {
    error: 'invalid_request',
    error_description: `No such endpoint: ${pathname}`,
  });
}

// Some clients assume the conventional bare paths; they are served by the
// same handlers as the advertised ones.
const PATH_ALIASES: Record<string, string> = {
  '/token': OAUTH_ROUTES.token,
  '/authorize': OAUTH_ROUTES.authorization,
};

function withCanonicalPath(req: Request): Request {
  const url = new URL(req.url);
  const canonical = PATH_ALIASES[url.pathname];
  if (!canonical) return req;
  url.pathname = canonical;
  return new Request(url, req);
}

function toResponse(resp: HandlerResponse): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(resp.headers ?? {})) {
    headers.set(key, String(value));
  }
  // 204 and 304 must not carry a body.
  const body = resp.statusCode === 204 || resp.statusCode === 304 ? null : resp.body ?? '';
  return new Response(body, { status: resp.statusCode, headers });
}


// A modern (Request => Response) function, so Netlify configures Blobs for it
// from the environment, including the uncached edge URL that strong reads
// need. The Lambda-compatibility form only receives Blobs credentials on the
// event, without that URL, and could only read the grant store eventually.
export default async (req: Request, context: Context): Promise<Response> => {
  // Establish request-scoped log context for the whole OAuth request so every
  // line from oAuthHandler and the auth-flow handlers it calls is correlated.
  return withLogContext(
    {
      service: 'oauth',
      requestId: getRequestId(req.headers),
      deployId: getDeployId(context?.deploy ? context : req.headers),
      httpMethod: req.method,
      path: truncateForLog(new URL(req.url).pathname),
      userAgent: truncateForLog(req.headers.get('user-agent')),
    },
    async () => {
      const resp = await oAuthHandler(withCanonicalPath(req));
      return toResponse(addCommonHeadersToHandlerResp(resp));
    }
  );
};

export const config: Config = {
  path: [
    '/oauth-server/*',
    '/token',
    '/authorize',
    '/register',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/*',
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
  ],
};
