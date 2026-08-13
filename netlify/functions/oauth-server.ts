import type { Handler, HandlerResponse } from "@netlify/functions";
import { handleAuthStart, handleClientRegistration, handleClientSideAuthExchange, handleCodeExchange, handleServerSideAuthRedirect } from "./mcp-server/auth-flow.ts";
import { buildAuthServerMetadata, buildProtectedResourceMetadata } from "./mcp-server/metadata.ts";
import { SUPPORTED_SCOPES, OAUTH_ROUTES } from "./mcp-server/oauth-config.ts";
import { addCommonHeadersToHandlerResp, headersToHeadersObject, getParsedUrl } from "./mcp-server/utils.ts";
import { safeBodySummary } from "./mcp-server/logging.ts";
import { log, withLogContext, getRequestId, initLogger, getDeployId } from "./mcp-server/logger.ts";
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
 * There is deliberately no revocation / introspection / userinfo / jwks /
 * device-flow / PAR endpoint; any other path returns a clean 404.
 */

function jsonResponse(statusCode: number, body: unknown): HandlerResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const oAuthHandler: Handler = async (req) => {
  log.debug('oauth request', { url: req.rawUrl });

  // Handle CORS preflight requests
  if (req.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      body: '',
    };
  }

  const parsedUrl = getParsedUrl(req);
  const pathname = parsedUrl.pathname;
  const reqObj = new Request(req.rawUrl, {
    method: req.httpMethod,
    headers: headersToHeadersObject(req.headers as Record<string, string>),
    body: req.body || null,
  });

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
  if (isRegistration && req.httpMethod === 'POST') {
    log.debug('registration request', { body: safeBodySummary(req.body) });
    return await handleClientRegistration(reqObj, SUPPORTED_SCOPES);
  }

  // The interactive authorization flow, handled directly.
  if (pathname.endsWith(OAUTH_ROUTES.authorization)) {
    return await handleAuthStart(reqObj);
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

  // No other OAuth endpoints exist on this server. Return a clean OAuth-style
  // error rather than letting the request fall through to a generic 404 page.
  log.warn('oauth: unknown endpoint', { pathname, method: req.httpMethod });
  return jsonResponse(404, {
    error: 'invalid_request',
    error_description: `No such endpoint: ${pathname}`,
  });
};


export const handler: Handler = async (req, context) => {
  // Establish request-scoped log context for the whole OAuth request so every
  // line from oAuthHandler and the auth-flow handlers it calls is correlated.
  return withLogContext(
    {
      service: 'oauth',
      requestId: getRequestId(req.headers as Record<string, string | undefined>),
      deployId: getDeployId(req.headers as Record<string, string | undefined>),
      httpMethod: req.httpMethod,
      path: req.path,
      userAgent: (req.headers as Record<string, string | undefined>)['user-agent'],
    },
    async () => {
      const resp = await oAuthHandler(req, context);
      return resp ? addCommonHeadersToHandlerResp(resp) : {
        statusCode: 500,
        body: JSON.stringify({ error: 'Internal Server Error' }),
        headers: { 'Content-Type': 'application/json' },
      };
    }
  );
}
