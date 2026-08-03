import { getOAuthIssuer } from "./utils.ts";
import {
  SUPPORTED_SCOPES,
  SUPPORTED_GRANT_TYPES,
  TOKEN_ENDPOINT_AUTH_METHODS,
  OAUTH_ROUTES,
  RESOURCE_PATH,
} from "./oauth-config.ts";

// Resolve a relative endpoint path to an absolute URL under the issuer. Using
// getOAuthIssuer() (which canonicalizes the trailing slash) as the base means
// every advertised URL byte-matches the issuer origin, including scheme — so on
// a localhost issuer these come out http, and on a deployed issuer https, with
// no post-processing needed.
function abs(path: string): string {
  return new URL(path, getOAuthIssuer()).toString();
}

/**
 * RFC 8414 Authorization Server Metadata.
 *
 * Hand-built (no OIDC library): this is a plain OAuth 2.1 AS. We advertise ONLY
 * the endpoints the MCP auth spec requires and that we actually implement —
 * authorize, token, registration, plus PKCE. There is deliberately no
 * revocation / introspection / userinfo / jwks / device-flow / PAR endpoint, so
 * none are advertised here.
 *
 * `authorization_response_iss_parameter_supported` is intentionally omitted (not
 * set false): we still EMIT `iss` on the authorization redirect
 * (handleServerSideAuthRedirect), we just don't advertise it — omission and
 * false are equivalent to a client, and some Codex builds break when it is
 * advertised true. See getsentry/sentry-mcp#1223.
 */
export function buildAuthServerMetadata() {
  return {
    issuer: getOAuthIssuer(),
    authorization_endpoint: abs(OAUTH_ROUTES.authorization),
    token_endpoint: abs(OAUTH_ROUTES.token),
    registration_endpoint: abs(OAUTH_ROUTES.registration),
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: [...SUPPORTED_GRANT_TYPES],
    token_endpoint_auth_methods_supported: [...TOKEN_ENDPOINT_AUTH_METHODS],
    // MCP mandates PKCE; S256 is the only method we accept (see handleCodeExchange).
    code_challenge_methods_supported: ['S256'],
  };
}

/**
 * RFC 9728 Protected Resource Metadata. MCP clients read `authorization_servers`
 * from this document to discover where to authenticate; without it they can't
 * bootstrap the OAuth flow. The AS is this same origin, so we point at the
 * canonical issuer directly (byte-identical to the AS metadata `issuer`).
 */
export function buildProtectedResourceMetadata() {
  return {
    resource: abs(RESOURCE_PATH),
    authorization_servers: [getOAuthIssuer()],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ['header'],
  };
}
