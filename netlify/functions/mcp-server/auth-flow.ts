import type { HandlerResponse } from "@netlify/functions";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { createJWE, decryptJWE, getOAuthIssuer, TOKEN_USE } from "./utils.ts";
import { maskToken } from "./logging.ts";
import { log, truncateForLog } from "./logger.ts";
import { resolveIdentity, type TokenIdentity } from "./identity.ts";
import {
  classifyUnresolvedClientId,
  createStatelessClientId,
  inferApplicationType,
  isRedirectUriAllowed,
  resolveClient,
  type RegisteredClient,
} from "./client-registry.ts";
import { attributionParams } from "./agent-attribution.ts";
// Grant types this Authorization Server issues, shared with the discovery
// metadata so registration validation and what we advertise can't drift apart.
import { SUPPORTED_GRANT_TYPES } from "./oauth-config.ts";

/** Host of a redirect_uri for logging, without leaking the full URI. */
function redirectHostForLog(redirectUri: string): string {
  try {
    return truncateForLog(new URL(redirectUri).host) || 'unknown';
  } catch {
    return 'unparseable';
  }
}

/**
 * Redirect_uri validation gate. `error` is an OAuth error response when the
 * request must be rejected, or null when it may proceed. `client` is the
 * client resolved for this client_id (null when unresolved), handed back so a
 * caller that needs it (e.g. for its `client_name`) doesn't have to resolve
 * it again.
 *
 * Fails closed: a redirect_uri the client did not register, or a client_id
 * this server cannot resolve, gets a 400 and is never redirected to (RFC 6749
 * §4.1.2.1 forbids redirecting on an invalid redirect_uri). The 400 lands in
 * the user's browser, not at the client, so a client with an id this server
 * no longer knows (a legacy opaque id, or a stateless id from before a
 * JWE_SECRET rotation) only recovers when it registers again; a client that
 * must keep working with such an id is pinned in oauth-clients.ts.
 */
async function validateClientRedirect(
  clientId: string,
  redirectUri: string,
  op: string,
): Promise<{ error: HandlerResponse | null; client: RegisteredClient | null }> {
  const { client, source } = await resolveClient(clientId);

  if (client && isRedirectUriAllowed(client, redirectUri)) {
    log.debug(`${op}: redirect_uri validated`, { client_id: maskToken(clientId), source });
    return { error: null, client };
  }

  // `reason` says WHY the request failed, since `source: unknown` alone
  // conflates several situations that call for different fixes:
  //  - 'redirect_mismatch': the client resolved fine (static or stateless) but
  //    this redirect_uri isn't one it registered — the attack-relevant case.
  //  - 'jwe-like' / 'opaque' / 'empty': the client_id itself couldn't be
  //    resolved at all — see classifyUnresolvedClientId for what each implies.
  const [error, description] = client
    ? ['invalid_request', 'redirect_uri does not match a registered redirect URI for this client']
    : ['invalid_client', 'This server does not know this client_id; the client must register with it again'];
  return {
    error: oauthError(400, error, description, op, {
      source,
      reason: client ? 'redirect_mismatch' : classifyUnresolvedClientId(clientId),
      client_id: maskToken(clientId),
      redirect_host: redirectHostForLog(redirectUri),
    }),
    client,
  };
}


interface AUTH_REQUEST_STATE {
  response_type: 'code';
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  state?: string;
  scope?: string;
  nonce?: string;
}

// The browser carries this through app.netlify.com as `state`. It is sealed so
// it cannot be authored, and `browser_binding` must match the cookie set on the
// consent page, so it only completes in the browser of the person who approved
// it. (`nonce` is the client's own OIDC parameter, passed through untouched.)
interface AUTH_TRANSACTION_PAYLOAD extends AUTH_REQUEST_STATE {
  token_use: typeof TOKEN_USE.authorizationRequest;
  browser_binding: string;
}

interface CODE_JWE_PAYLOAD {
  token_use: typeof TOKEN_USE.authorizationCode;
  state: Partial<AUTH_REQUEST_STATE>;
  accessToken: string;
  // Resolved once at server-redirect and carried through so it can be attached
  // to logs on later requests. Optional: absent on failure and on tokens issued
  // before identity resolution existed.
  identity?: TokenIdentity;
}

interface ACCESS_TOKEN_PAYLOAD {
  token_use: typeof TOKEN_USE.access;
  accessToken: string;
  identity?: TokenIdentity;
}

interface REFRESH_TOKEN_PAYLOAD {
  token_use: typeof TOKEN_USE.refresh;
  accessToken: string;
  identity?: TokenIdentity;
}

const NTL_AUTH_CLIENT_ID = process.env.NTL_AUTH_CLIENT_ID || '';
const AUTH_REQUIRED_PARAMS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method'] as const;
const AUTH_OPTIONAL_PARAMS = ['state', 'scope', 'nonce'] as const;

// Long enough to sign up and verify an email at app.netlify.com on the way.
const AUTH_TRANSACTION_TTL_SECONDS = 30 * 60;
// The client exchanges the code as soon as its redirect receives it.
const AUTH_CODE_TTL = '5m';
// __Host- pins the cookie to this exact origin over HTTPS, so neither another
// netlify.app site nor a subdomain can plant a binding in the victim's browser.
const AUTH_TRANSACTION_COOKIE = '__Host-mcp-oauth-txn';

function transactionCookie(value: string, maxAge: number): string {
  return `${AUTH_TRANSACTION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function readTransactionCookie(req: Request): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === AUTH_TRANSACTION_COOKIE) {
      return value.join('=') || null;
    }
  }
  return null;
}

function sameBinding(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Pages that hand a person to another site must not be framed: the click that
// approves a client has to be one the person meant to make on this page.
const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

/**
 * The consent page every authorization goes through. Netlify's own consent
 * screen names only this server's OAuth app, and dynamic registration lets
 * anyone register a client with their own redirect_uri, so without this page a
 * link to /auth was enough to send a person's Netlify token wherever the link's
 * author chose. The redirect host is the fact that matters; the client_name is
 * whatever the client registered, and is shown as such.
 */
function consentPage(clientName: string | undefined, redirectUri: string, netlifyAuthorizeUrl: string, cancelUrl: string): string {
  // The scheme stays: a custom scheme or plain http in front of a familiar host
  // is exactly what a look-alike registration would rely on hiding.
  const url = new URL(redirectUri);
  const destination = escapeHtml(url.host ? `${url.protocol}//${url.host}` : redirectUri);
  const name = clientName ? `<strong>${escapeHtml(clientName)}</strong> (the name the application gave itself)` : 'An application';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect to Netlify</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #181a1c; line-height: 1.5; }
    .destination { font-family: ui-monospace, monospace; font-size: 1.1rem; background: #f3f3f4; padding: .5rem .75rem; border-radius: 4px; word-break: break-all; }
    .actions { display: flex; gap: 1rem; margin-top: 2rem; }
    a.button { padding: .6rem 1.2rem; border-radius: 4px; text-decoration: none; border: 1px solid #181a1c; color: #181a1c; }
    a.primary { background: #04716f; border-color: #04716f; color: #fff; }
  </style>
</head>
<body>
  <h1>Connect to Netlify</h1>
  <p>${name} wants to use the Netlify MCP server with your Netlify account. It will be able to do anything you can do on Netlify.</p>
  <p>After you sign in, your access will be sent to:</p>
  <p class="destination">${destination}</p>
  <p>Only continue if you started this connection from that application.</p>
  <div class="actions">
    <a class="button primary" id="continue" href="${escapeHtml(netlifyAuthorizeUrl)}">Continue to Netlify</a>
    <a class="button" id="cancel" href="${escapeHtml(cancelUrl)}">Cancel</a>
  </div>
</body>
</html>
`;
}

/**
 * Resolve the client_id from a token request. Clients may authenticate using
 * either client_secret_post (client_id in the form body) or client_secret_basic
 * (client_id in the `Authorization: Basic` header, per RFC 6749 §2.3.1). Some
 * clients send Basic auth regardless of the advertised
 * token_endpoint_auth_method, so we check both locations.
 */
function getClientIdFromRequest(req: Request, bodyParams: URLSearchParams): string | null {
  const fromBody = bodyParams.get('client_id');
  if (fromBody) {
    return fromBody;
  }

  // Auth scheme is case-insensitive (RFC 7235) and may be separated from the
  // credentials by arbitrary whitespace, so normalize before matching.
  const authHeader = req.headers.get('authorization')?.trim() ?? '';
  const [scheme, ...rest] = authHeader.split(/\s+/);
  if (scheme.toLowerCase() === 'basic' && rest.length > 0) {
    try {
      const decoded = Buffer.from(rest.join(''), 'base64').toString('utf8');
      // Basic credentials are `urlencode(client_id):urlencode(client_secret)`
      const clientId = decoded.split(':')[0];
      return clientId ? decodeURIComponent(clientId) : null;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Build an OAuth error response and log it. `op` identifies which call failed
 * (e.g. 'authorize', 'token', 'token/refresh', 'server-redirect') and `context`
 * carries any extra detail about why, so failures are traceable from the logs.
 */
function oauthError(
  statusCode: number,
  error: string,
  errorDescription: string,
  op?: string,
  context?: Record<string, unknown>,
): HandlerResponse {
  log.error('oauth error', {
    op: op ?? 'unknown',
    statusCode,
    error,
    error_description: errorDescription,
    ...context,
  });
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
    body: JSON.stringify({
      error,
      error_description: errorDescription,
    }),
  };
}


export async function handleAuthStart(req: Request): Promise<HandlerResponse>{

  const parsedUrl = new URL(req.url);
  const params = parsedUrl.searchParams;
  
  log.debug('authorize start', { client_id: params.get('client_id'), redirect_uri: params.get('redirect_uri'), scope: params.get('scope') });

  const missingParams = AUTH_REQUIRED_PARAMS.filter(param => !params.get(param));
  if (missingParams.length > 0) {
    return oauthError(400, 'invalid_request', `Missing required parameters: ${missingParams.join(', ')}`, 'authorize', { missingParams, client_id: params.get('client_id') });
  }

  const responseType = params.get('response_type');
  if (responseType !== 'code') {
    return oauthError(400, 'unsupported_response_type', 'Only response_type=code is supported', 'authorize', { responseType, client_id: params.get('client_id') });
  }

  const codeChallengeMethod = params.get('code_challenge_method');
  if (codeChallengeMethod !== 'S256') {
    return oauthError(400, 'invalid_request', 'code_challenge_method must be S256', 'authorize', { codeChallengeMethod, client_id: params.get('client_id') });
  }

  const clientId = params.get('client_id') as string;
  const redirectUri = params.get('redirect_uri') as string;
  const codeChallenge = params.get('code_challenge') as string;

  // Validate the redirect_uri against the client's registration BEFORE it enters
  // the round-tripped state. This is the primary defense against an open redirect:
  // an unregistered redirect_uri never makes it into the authorization code, so
  // handleServerSideAuthRedirect can only ever 302 to a URI the client registered.
  const { error: redirectError, client } = await validateClientRedirect(clientId, redirectUri, 'authorize');
  if (redirectError) {
    return redirectError;
  }

  const paramsObj: AUTH_REQUEST_STATE = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  };

  for (const param of AUTH_OPTIONAL_PARAMS) {
    const value = params.get(param);
    if (value) {
      paramsObj[param] = value;
    }
  }

  const browserBinding = randomBytes(32).toString('base64url');
  const transaction = await createJWE(
    { ...paramsObj, token_use: TOKEN_USE.authorizationRequest, browser_binding: browserBinding } satisfies AUTH_TRANSACTION_PAYLOAD,
    `${AUTH_TRANSACTION_TTL_SECONDS}s`,
  );
  const netlifyRedirectUri = `${parsedUrl.origin}/oauth-server/client-redirect`;
  const netlifyAuthorizeUrl = `https://app.netlify.com/authorize?client_id=${NTL_AUTH_CLIENT_ID}&response_type=token&state=${encodeURIComponent(transaction)}&redirect_uri=${netlifyRedirectUri}&utm_source=mcp&utm_campaign=integrations${attributionParams(client?.client_name)}`;

  const cancelUrl = new URL(redirectUri);
  cancelUrl.searchParams.set('error', 'access_denied');
  if (paramsObj.state) {
    cancelUrl.searchParams.set('state', paramsObj.state);
  }
  cancelUrl.searchParams.set('iss', getOAuthIssuer());

  return {
    statusCode: 200,
    headers: {
      ...PAGE_HEADERS,
      'Set-Cookie': transactionCookie(browserBinding, AUTH_TRANSACTION_TTL_SECONDS),
    },
    body: consentPage(client?.client_name, redirectUri, netlifyAuthorizeUrl, cancelUrl.toString()),
  };
}


export async function handleClientSideAuthExchange(){
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Referrer-Policy': 'no-referrer',
    },
    body: `
<!DOCTYPE html>
<html>
<head>
    <title>OAuth Client Redirect</title>
</head>
<body>
  <p>Redirecting to the client application...</p>

  <script>
    let hash = window.location.hash;
    let hashToken = '';
    let hashState = '';

    if(hash.startsWith('#')){
      hash = hash.slice(1);
    }

    if(hash.startsWith('?')){
      hash = hash.slice(1);
    }

    if(hash.includes('=')) {
      const params = new URLSearchParams(hash);
      const token = params.get('access_token') || params.get('token');
      const state = params.get('state');
      if(state) {
        hashState = state;
      }
      if(token) {
        hashToken = token;
      }
    }else {
      hashToken = hash;
    }

    // POST, so the Netlify token never sits in a URL, a log line or history.
    history.replaceState(null, '', window.location.pathname);
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/oauth-server/server-redirect';
    for (const [name, value] of [['token', hashToken], ['init-state', hashState]]) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
  </script>
</body>
</html>
`
  };
}


export async function handleServerSideAuthRedirect(req: Request): Promise<HandlerResponse> {
  if (req.method !== 'POST') {
    return oauthError(405, 'invalid_request', 'The authorization response must be posted from the client-redirect page', 'server-redirect', { method: req.method });
  }

  const form = new URLSearchParams(await req.text());
  const initState = form.get('init-state');
  const token = form.get('token');

  if (!initState || !token) {
    return oauthError(400, 'invalid_request', `Missing required parameters: ${!initState ? 'init-state' : ''} ${!token ? 'token' : ''}`.trim(), 'server-redirect', { hasInitState: !!initState, hasToken: !!token });
  }

  let transaction: AUTH_TRANSACTION_PAYLOAD;
  try {
    transaction = (await decryptJWE(initState)) as any as AUTH_TRANSACTION_PAYLOAD;
  } catch (error) {
    return oauthError(400, 'invalid_request', 'Invalid or expired authorization request. Start the connection again from your application.', 'server-redirect', { reason: 'init-state decrypt failed', detail: error instanceof Error ? error.message : String(error) });
  }

  if (transaction?.token_use !== TOKEN_USE.authorizationRequest || typeof transaction.browser_binding !== 'string') {
    return oauthError(400, 'invalid_request', 'Invalid or expired authorization request. Start the connection again from your application.', 'server-redirect', { reason: 'init-state is not an authorization request', token_use: transaction?.token_use });
  }

  // Without this, a sealed state minted for the attacker's own /auth visit
  // would complete in the victim's browser.
  const cookieBinding = readTransactionCookie(req);
  if (!cookieBinding || !sameBinding(cookieBinding, transaction.browser_binding)) {
    return oauthError(400, 'invalid_request', 'This sign-in was started in a different browser, replaced by a newer one, or has already finished. Start the connection again from your application.', 'server-redirect', { reason: cookieBinding ? 'browser binding mismatch' : 'no transaction cookie' });
  }

  const validatedState: AUTH_REQUEST_STATE = {
    response_type: 'code',
    client_id: transaction.client_id,
    redirect_uri: transaction.redirect_uri,
    code_challenge: transaction.code_challenge,
    code_challenge_method: 'S256',
    ...(transaction.state ? { state: transaction.state } : {}),
    ...(transaction.scope ? { scope: transaction.scope } : {}),
    ...(transaction.nonce ? { nonce: transaction.nonce } : {}),
  };

  // Defense in depth: the registration could have changed since /auth (a
  // static client removed, a JWE_SECRET rotation), so check it again before
  // the code is sent anywhere.
  const { error: redirectError } = await validateClientRedirect(validatedState.client_id, validatedState.redirect_uri, 'server-redirect');
  if (redirectError) {
    return redirectError;
  }

  const rediredctURL = new URL(validatedState.redirect_uri);

  if(validatedState.state) {
    rediredctURL.searchParams.set('state', validatedState.state);
  }

  // RFC 9207: Include iss parameter in authorization response
  rediredctURL.searchParams.set('iss', getOAuthIssuer());

  // Resolve the user/team for this token once, here, so it can be embedded in
  // the code (and downstream access/refresh tokens) without a per-request
  // lookup. Best-effort — never blocks issuing the code.
  const identity = await resolveIdentity(token);

  log.info('server redirect: issuing authorization code', { client_id: maskToken(validatedState.client_id), redirect_host: redirectHostForLog(validatedState.redirect_uri), scope: truncateForLog(validatedState.scope), hasIdentity: !!identity });

  const jwe = await createJWE(
    { token_use: TOKEN_USE.authorizationCode, state: validatedState, accessToken: token, ...(identity ? { identity } : {}) } satisfies CODE_JWE_PAYLOAD,
    AUTH_CODE_TTL,
  );

  rediredctURL.searchParams.set('code', jwe);

  return {
    statusCode: 302,
    headers: {
      'Location': rediredctURL.toString(),
      // One approval, one code: the same browser cannot replay the transaction.
      'Set-Cookie': transactionCookie('', 0),
    },
    body: ''
  };
}


/**
 * RFC 7591 Dynamic Client Registration, stateless.
 *
 * We don't persist the client anywhere: the returned `client_id` IS a JWE of the
 * registered metadata (see client-registry.ts), so a later authorize/token
 * request can recover and validate it with no lookup. This keeps registration
 * working behind a plain round-robin load balancer with no shared store.
 *
 * `supportedScopes` is threaded in from the OAuth server config so requested
 * scopes are sanitized down to what this AS actually grants (an unsupported
 * scope is dropped rather than failing the whole registration).
 */
export async function handleClientRegistration(req: Request, supportedScopes: string[]): Promise<HandlerResponse> {
  let body: Record<string, any>;
  try {
    body = JSON.parse(await req.text());
  } catch (error) {
    return oauthError(400, 'invalid_client_metadata', 'Registration body must be valid JSON', 'register', { detail: error instanceof Error ? error.message : String(error) });
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u: unknown): u is string => typeof u === 'string')
    : [];

  // Intersect requested grant types with what we support; default to
  // authorization_code when the client sends none.
  const requestedGrantTypes: string[] = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code'];
  const grantTypes = requestedGrantTypes.filter((g) => SUPPORTED_GRANT_TYPES.includes(g));
  const effectiveGrantTypes = grantTypes.length > 0 ? grantTypes : ['authorization_code'];

  // redirect_uris are required for the authorization_code flow (the only flow
  // that redirects). RFC 7591 §3.2.2 uses `invalid_redirect_uri` for this.
  if (effectiveGrantTypes.includes('authorization_code') && redirectUris.length === 0) {
    return oauthError(400, 'invalid_redirect_uri', 'At least one redirect_uri is required for the authorization_code grant', 'register');
  }

  // Sanitize requested scopes to the supported set (drop the field if nothing
  // remains) so an unsupported scope doesn't fail the whole registration.
  let scope: string | undefined;
  if (typeof body.scope === 'string') {
    const allowed = body.scope.split(/\s+/).filter((s: string) => s && supportedScopes.includes(s));
    scope = allowed.length > 0 ? allowed.join(' ') : undefined;
  }

  // Always infer rather than trust a client-supplied value: a client that
  // mislabels a custom-scheme or loopback redirect as `web` would otherwise be
  // stored as the invalid combination `web` + non-web redirect (a `web` client
  // must use only https web URIs).
  const applicationType = inferApplicationType(redirectUris);

  const client: Omit<RegisteredClient, 'client_id'> = {
    redirect_uris: redirectUris,
    grant_types: effectiveGrantTypes,
    response_types: ['code'],
    // Public PKCE clients: we issue no client_secret and don't persist one.
    token_endpoint_auth_method: 'none',
    application_type: applicationType,
    ...(scope ? { scope } : {}),
    ...(typeof body.client_name === 'string' ? { client_name: body.client_name } : {}),
  };

  const clientId = await createStatelessClientId(client);

  // client_name, redirect_uris, and scope are client-asserted: nothing verifies
  // client_name, and a registration can send arbitrarily many/long redirect_uris.
  // The bounded copies below are for this log line only — the stored client and
  // the response below carry the full, untouched values.
  const MAX_LOGGED_REDIRECT_URIS = 10;

  log.info('register: issued stateless client_id', {
    redirect_hosts: redirectUris.slice(0, MAX_LOGGED_REDIRECT_URIS).map(redirectHostForLog),
    application_type: applicationType,
    scope: truncateForLog(scope),
    client_name: truncateForLog(body.client_name),
  });

  // RFC 7591 §3.2.1 success response. client_id_issued_at is informational; the
  // registration never expires (no client_secret_expires_at needed for a public
  // client), and revocation is via JWE_SECRET rotation.
  const registration: Record<string, any> = {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    grant_types: effectiveGrantTypes,
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: applicationType,
    ...(scope ? { scope } : {}),
    ...(typeof body.client_name === 'string' ? { client_name: body.client_name } : {}),
  };

  return {
    statusCode: 201,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
    body: JSON.stringify(registration),
  };
}


export async function handleCodeExchange(req: Request): Promise<HandlerResponse> {

  const body = await req.text();

  // get data from application/x-www-form-urlencoded body
  const bodyParams = new URLSearchParams(body);
  const grantType = bodyParams.get('grant_type') || 'authorization_code';

  log.debug('token exchange', { grantType, client_id: bodyParams.get('client_id'), hasAuthHeader: !!req.headers.get('authorization') });

  // Handle refresh_token grant type
  if (grantType === 'refresh_token') {
    return handleRefreshTokenGrant(bodyParams);
  }

  // Handle authorization_code grant type. client_id may arrive in the body
  // (client_secret_post) or the Authorization header (client_secret_basic).
  const clientId = getClientIdFromRequest(req, bodyParams);
  const requiredParams: Record<string, string | null> = {
    code: bodyParams.get('code'),
    client_id: clientId,
    redirect_uri: bodyParams.get('redirect_uri'),
    code_verifier: bodyParams.get('code_verifier'),
  };
  const missingParams = Object.entries(requiredParams)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if(missingParams.length > 0) {
    return oauthError(400, 'invalid_request', `Missing required parameters: ${missingParams.join(', ')}`, 'token', {
      grantType,
      missingParams,
      clientIdSource: bodyParams.get('client_id') ? 'body' : (req.headers.get('authorization') ? 'authorization-header' : 'absent'),
    });
  }

  const code = requiredParams.code as string;
  const redirectUri = requiredParams.redirect_uri as string;
  const codeVerifier = requiredParams.code_verifier as string;

  let decryptedCode: CODE_JWE_PAYLOAD;
  try {
    decryptedCode = (await decryptJWE(code)) as any as CODE_JWE_PAYLOAD;
  } catch (error) {
    return oauthError(400, 'invalid_grant', 'Invalid or expired authorization code', 'token', {
      reason: 'authorization code decrypt failed',
      detail: error instanceof Error ? error.message : String(error),
      client_id: clientId,
    });
  }

  if (decryptedCode?.token_use !== TOKEN_USE.authorizationCode || !decryptedCode.state) {
    return oauthError(400, 'invalid_grant', 'Invalid or expired authorization code', 'token', {
      reason: 'not an authorization code',
      token_use: decryptedCode?.token_use,
      client_id: clientId,
    });
  }

  const { accessToken, state, identity } = decryptedCode;

  if (state.client_id !== clientId || state.redirect_uri !== redirectUri) {
    return oauthError(400, 'invalid_grant', 'client_id or redirect_uri does not match authorization code', 'token', {
      client_id: clientId,
      clientIdMatches: state.client_id === clientId,
      redirectUriMatches: state.redirect_uri === redirectUri,
    });
  }

  if (!state.code_challenge || state.code_challenge_method !== 'S256') {
    return oauthError(400, 'invalid_grant', 'Authorization code is missing PKCE binding', 'token', {
      client_id: clientId,
      hasCodeChallenge: !!state.code_challenge,
      codeChallengeMethod: state.code_challenge_method,
    });
  }

  if(!isPKCEValid(codeVerifier, state.code_challenge, state.code_challenge_method)) {
    return oauthError(400, 'invalid_grant', 'PKCE verification failed', 'token', { client_id: clientId });
  }

  const accessTokenJWE = await createJWE({ token_use: TOKEN_USE.access, accessToken, ...(identity ? { identity } : {}) } satisfies ACCESS_TOKEN_PAYLOAD, '48h');

  // Check if offline_access scope was requested
  const requestedScopes = state.scope ? state.scope.split(' ') : [];
  const hasOfflineAccess = requestedScopes.includes('offline_access');

  const tokenResponse: Record<string, any> = {
    "access_token": accessTokenJWE,
    "token_type": "Bearer",
    "expires_in": 172800 // 48 hours in seconds
  };

  // Only include refresh_token if offline_access was requested
  if (hasOfflineAccess) {
    const refreshTokenJWE = await createJWE(
      { token_use: TOKEN_USE.refresh, accessToken, ...(identity ? { identity } : {}) } satisfies REFRESH_TOKEN_PAYLOAD,
      '7d' // refresh token valid for 7 days
    );
    tokenResponse.refresh_token = refreshTokenJWE;
  }

  // The confident "user authenticated" point: the full OAuth handshake has
  // completed here (PKCE validated, session token minted) after Netlify
  // authenticated the human at server-redirect. Fires once per interactive
  // login; a silent refresh (handleRefreshTokenGrant) is deliberately NOT this.
  log.info('user authenticated', {
    userId: identity?.userId,
    teamId: identity?.teamId,
    client_id: clientId,
    hasOfflineAccess,
  });

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
    body: JSON.stringify(tokenResponse)
  }
}

async function handleRefreshTokenGrant(bodyParams: URLSearchParams): Promise<HandlerResponse> {
  const refreshToken = bodyParams.get('refresh_token');

  if (!refreshToken) {
    return oauthError(400, 'invalid_request', 'Missing required parameter: refresh_token', 'token/refresh', {
      clientIdSource: bodyParams.get('client_id') ? 'body' : 'absent',
    });
  }

  let payload: REFRESH_TOKEN_PAYLOAD;
  try {
    payload = (await decryptJWE(refreshToken)) as any as REFRESH_TOKEN_PAYLOAD;
  } catch (error) {
    return oauthError(400, 'invalid_grant', 'Invalid or expired refresh token', 'token/refresh', {
      reason: 'refresh token decrypt failed',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // Validate this is actually a refresh token. Ones minted before token_use
  // existed fail here too, and the client signs in again.
  if (payload?.token_use !== TOKEN_USE.refresh) {
    return oauthError(400, 'invalid_grant', 'Invalid token type', 'token/refresh', { token_use: payload?.token_use });
  }

  const { accessToken, identity } = payload;

  // Issue new access token and rotate refresh token, carrying identity forward
  // so it survives the token's full refresh lifetime.
  const newAccessTokenJWE = await createJWE({ token_use: TOKEN_USE.access, accessToken, ...(identity ? { identity } : {}) } satisfies ACCESS_TOKEN_PAYLOAD, '48h');
  const newRefreshTokenJWE = await createJWE(
    { token_use: TOKEN_USE.refresh, accessToken, ...(identity ? { identity } : {}) } satisfies REFRESH_TOKEN_PAYLOAD,
    '7d'
  );

  log.info('refresh token grant: issued new tokens', { userId: identity?.userId, teamId: identity?.teamId });

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
    body: JSON.stringify({
      "access_token": newAccessTokenJWE,
      "refresh_token": newRefreshTokenJWE,
      "token_type": "Bearer",
      "expires_in": 172800 // 48 hours in seconds
    })
  };
}


function isPKCEValid(codeVerifier: string, codeChallenge: string, codeChallengeMethod = 'S256') {
  if (codeChallengeMethod === 'plain') {
    return codeVerifier === codeChallenge;
  } else if (codeChallengeMethod === 'S256') {
    // SHA-256 hash the code_verifier, base64url encode, and compare
    const hash = createHash('sha256').update(codeVerifier).digest();
    const base64url = hash
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return base64url === codeChallenge;
  } else {
    // Unknown/unsupported method
    return false;
  }
}
