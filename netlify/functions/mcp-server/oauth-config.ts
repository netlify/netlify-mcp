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

// Grant types this AS issues. Single source of truth: the discovery metadata
// advertises these, and handleClientRegistration (auth-flow.ts) intersects
// registration requests against them so a client can't register for a flow we
// don't run.
export const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'];

// Token endpoint auth methods we accept: `none` for public PKCE clients (dynamic
// registration), plus client_secret_post / client_secret_basic for the static
// pre-provisioned clients (see oauth-clients.ts).
export const TOKEN_ENDPOINT_AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'];

// The OAuth endpoint paths this function serves. Kept relative; metadata.ts
// resolves them against the issuer to advertise absolute URLs.
export const OAUTH_ROUTES = {
  authorization: '/oauth-server/auth',
  consent: '/oauth-server/consent',
  token: '/oauth-server/token',
  revocation: '/oauth-server/revoke',
  registration: '/oauth-server/reg',
  clientRedirect: '/oauth-server/client-redirect',
  serverRedirect: '/oauth-server/server-redirect',
} as const;

// What the consent screen says each scope means. Kept honest: the upstream
// Netlify token is the user's full login, and the tools do not narrow it by
// scope, so these describe what the client asked for, not a boundary.
export const SCOPE_DESCRIPTIONS: Record<string, string> = {
  read: 'read your projects, deploys, forms, environment variables and team details',
  write: 'create and change projects, deploys, environment variables, DNS and team settings',
  offline_access: 'stay connected without signing in again (a refresh token valid for up to 7 days at a time)',
  claudeai: 'a marker scope Claude sends; it grants nothing additional',
};

// The protected resource this AS guards (the MCP server). Advertised as the
// `resource` in the RFC 9728 protected-resource metadata.
export const RESOURCE_PATH = '/mcp';
