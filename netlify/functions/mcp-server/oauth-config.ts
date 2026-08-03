// Single source of truth for the Authorization Server's advertised surface.
// Both the request router (oauth-server.ts) and the discovery documents
// (metadata.ts) import from here so the endpoints we ROUTE and the endpoints we
// ADVERTISE can never drift apart.

// Scopes the Authorization Server supports. Dynamic client registration requests
// are sanitized against this list (see handleClientRegistration) so a client
// asking for an unsupported scope doesn't get its whole registration rejected.
//
// `openid` is intentionally omitted: this is a plain OAuth 2.1 Authorization
// Server (MCP auth), not an OIDC provider. The token endpoint issues no id_token,
// so we neither advertise nor grant `openid` — otherwise OIDC clients would
// expect an id_token and fail when none comes back.
export const SUPPORTED_SCOPES = [
  'offline_access',
  'read',
  'write',
  'claudeai', // temp until this bug is fixed: https://github.com/modelcontextprotocol/modelcontextprotocol/issues/653
];

// Grant types this AS issues. Registration requests are intersected with this
// set (see auth-flow.ts SUPPORTED_GRANT_TYPES, which must stay in sync).
export const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'];

// Token endpoint auth methods we accept: `none` for public PKCE clients (dynamic
// registration), plus client_secret_post / client_secret_basic for the static
// pre-provisioned clients (see oauth-clients.ts).
export const TOKEN_ENDPOINT_AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'];

// The OAuth endpoint paths this function serves. Kept relative; metadata.ts
// resolves them against the issuer to advertise absolute URLs.
export const OAUTH_ROUTES = {
  authorization: '/oauth-server/auth',
  token: '/oauth-server/token',
  registration: '/oauth-server/reg',
  clientRedirect: '/oauth-server/client-redirect',
  serverRedirect: '/oauth-server/server-redirect',
} as const;

// The protected resource this AS guards (the MCP server). Advertised as the
// `resource` in the RFC 9728 protected-resource metadata.
export const RESOURCE_PATH = '/mcp';
