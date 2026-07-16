import { HandlerResponse } from "@netlify/functions";
import { createHash } from "crypto";
import { createJWE, decryptJWE, getOAuthIssuer } from "./utils.ts";
import { maskToken } from "./logging.ts";
import { log } from "./logger.ts";
import { resolveIdentity, type TokenIdentity } from "./identity.ts";
import {
  createStatelessClientId,
  inferApplicationType,
  isRedirectUriAllowed,
  resolveClient,
  type RegisteredClient,
} from "./client-registry.ts";

// Grant types this Authorization Server issues. Registration requests are
// intersected with this set so a client can't register for a flow we don't run.
const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;

/**
 * When true, any request whose redirect_uri we can't match to a registration is
 * rejected — a stateless client presenting a redirect it didn't register, a
 * static client whose exact redirect string we haven't verified, or a
 * legacy/foreign `client_id` we can't resolve. Defaults to FALSE so deploying
 * this introduces no breaking change for any existing client: every such case
 * is logged (see the always-on warn below) but allowed. Flip
 * DCR_REJECT_UNKNOWN_CLIENTS=true to turn those warnings into hard rejections
 * once the logs show it's safe to enforce.
 */
function rejectUnknownClients(): boolean {
  const v = (process.env.DCR_REJECT_UNKNOWN_CLIENTS ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

/** Host of a redirect_uri for logging, without leaking the full URI. */
function redirectHostForLog(redirectUri: string): string {
  try {
    return new URL(redirectUri).host || 'unknown';
  } catch {
    return 'unparseable';
  }
}

/**
 * Redirect_uri validation gate. Returns an OAuth error response when the
 * request must be rejected, or null when it may proceed.
 *
 * Log-only by default: a request that matches a registration proceeds quietly;
 * anything else (a stateless/static client whose redirect doesn't match, or an
 * unresolvable client_id) is ALLOWED but recorded via an always-on warning, so
 * deploying this can't break any existing client. Setting
 * DCR_REJECT_UNKNOWN_CLIENTS=true turns those warnings into hard rejections.
 */
async function validateClientRedirect(
  clientId: string,
  redirectUri: string,
  op: string,
): Promise<HandlerResponse | null> {
  const { client, source } = await resolveClient(clientId);

  if (client && isRedirectUriAllowed(client, redirectUri)) {
    log.debug(`${op}: redirect_uri validated`, { client_id: clientId, source });
    return null;
  }

  if (rejectUnknownClients()) {
    const [error, description] = client
      ? ['invalid_request', 'redirect_uri does not match a registered redirect URI for this client']
      : ['invalid_client', 'Unregistered client_id or redirect_uri'];
    return oauthError(400, error, description, op, { client_id: clientId, source, redirect_uri: redirectUri });
  }

  // Log-only mode: surface unconditionally (not log.debug) so operators can see
  // this traffic in steady state and decide when it's safe to enforce.
  log.warn('[oauth] redirect_uri not validated (allowed; set DCR_REJECT_UNKNOWN_CLIENTS=true to enforce)', {
    op,
    source,
    client_id: maskToken(clientId),
    redirect_host: redirectHostForLog(redirectUri),
  });
  return null;
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

interface CODE_JWE_PAYLOAD {
  state: Partial<AUTH_REQUEST_STATE>;
  accessToken: string;
  // Resolved once at server-redirect and carried through so it can be attached
  // to logs on later requests. Optional: absent on failure and on tokens issued
  // before identity resolution existed.
  identity?: TokenIdentity;
}

interface ACCESS_TOKEN_PAYLOAD {
  accessToken: string;
  identity?: TokenIdentity;
}

interface REFRESH_TOKEN_PAYLOAD {
  accessToken: string;
  type: 'refresh';
  identity?: TokenIdentity;
}

const NTL_AUTH_CLIENT_ID = process.env.NTL_AUTH_CLIENT_ID || '';
const AUTH_REQUIRED_PARAMS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method'] as const;
const AUTH_OPTIONAL_PARAMS = ['state', 'scope', 'nonce'] as const;

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
  const redirectError = await validateClientRedirect(clientId, redirectUri, 'authorize');
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

  // b64 value for the redirects
  const paramsState = Buffer.from(JSON.stringify(paramsObj), 'utf-8').toString('base64');
  const netlifyRedirectUri = `${parsedUrl.origin}/oauth-server/client-redirect`;

  return {
    statusCode: 302,
    headers: {
      'Location': `https://app.netlify.com/authorize?client_id=${NTL_AUTH_CLIENT_ID}&response_type=token&state=${paramsState}&redirect_uri=${netlifyRedirectUri}`
    },
    body: ''
  };
}


export async function handleClientSideAuthExchange(){
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
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

    window.location.href = '/oauth-server/server-redirect?token=' + hashToken + '&init-state=' + hashState;
  </script>
</body>
</html>
`
  };
}


export async function handleServerSideAuthRedirect(req: Request): Promise<HandlerResponse> {  
  const parsedUrl = new URL(req.url);
  const initState = parsedUrl.searchParams.get('init-state');
  const token = parsedUrl.searchParams.get('token');

  if (!initState || !token) {
    return oauthError(400, 'invalid_request', `Missing required parameters: ${!initState ? 'init-state' : ''} ${!token ? 'token' : ''}`.trim(), 'server-redirect', { hasInitState: !!initState, hasToken: !!token });
  }

  try {
    const stateObj = JSON.parse(Buffer.from(initState, 'base64').toString('utf-8')) as Partial<AUTH_REQUEST_STATE>;

    const requiredStateParams: Array<keyof AUTH_REQUEST_STATE> = [
      'client_id',
      'redirect_uri',
      'code_challenge',
      'code_challenge_method',
      'response_type',
    ];

    for (const param of requiredStateParams) {
      if (!stateObj[param]) {
        return oauthError(400, 'invalid_request', `Missing required parameter in init-state: ${param}`, 'server-redirect', { missingStateParam: param });
      }
    }

    const expectedStateValues: Pick<AUTH_REQUEST_STATE, 'code_challenge_method' | 'response_type'> = {
      code_challenge_method: 'S256',
      response_type: 'code',
    };

    for (const [param, expectedValue] of Object.entries(expectedStateValues)) {
      const value = stateObj[param as keyof typeof expectedStateValues];
      if (value !== expectedValue) {
        return oauthError(400, 'invalid_request', `Invalid ${param} in init-state`, 'server-redirect', { param, value, expected: expectedValue });
      }
    }

    const clientId = stateObj.client_id as string;
    const redirectUri = stateObj.redirect_uri as string;
    const codeChallenge = stateObj.code_challenge as string;

    const validatedState: AUTH_REQUEST_STATE = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      ...(stateObj.state ? { state: stateObj.state } : {}),
      ...(stateObj.scope ? { scope: stateObj.scope } : {}),
      ...(stateObj.nonce ? { nonce: stateObj.nonce } : {}),
    };

    // Defense in depth: init-state round-trips through the browser, so re-check
    // the redirect_uri against the client's registration before we 302 to it.
    const redirectError = await validateClientRedirect(validatedState.client_id, validatedState.redirect_uri, 'server-redirect');
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

    // TODO: future, we will add specific tools and other context to this for
    // downstream validation
    log.info('server redirect: issuing authorization code', { client_id: validatedState.client_id, redirect_uri: validatedState.redirect_uri, scope: validatedState.scope, hasIdentity: !!identity });

    const jwe = await createJWE({ state: validatedState, accessToken: token, ...(identity ? { identity } : {}) } satisfies CODE_JWE_PAYLOAD);

    rediredctURL.searchParams.set('code', jwe);

    return {
      statusCode: 302,
      headers: {
        'Location': rediredctURL.toString(),
      },
      body: ''
    };
  
  } catch (error) {
    return oauthError(400, 'invalid_request', 'Invalid init-state parameter', 'server-redirect', { reason: 'init-state parse failed', detail: error instanceof Error ? error.message : String(error) });
  }
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
  const grantTypes = requestedGrantTypes.filter((g) => (SUPPORTED_GRANT_TYPES as readonly string[]).includes(g));
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
  // stored as an invalid `web` + non-web-redirect combination that
  // oidc-provider's client validation rejects if the client ever hits an
  // oidc-handled endpoint (e.g. revocation).
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

  log.debug('register: issued stateless client_id', { redirect_uris: redirectUris, application_type: applicationType, scope });

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

  const accessTokenJWE = await createJWE({ accessToken, ...(identity ? { identity } : {}) } satisfies ACCESS_TOKEN_PAYLOAD, '48h');

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
      { accessToken, type: 'refresh', ...(identity ? { identity } : {}) } satisfies REFRESH_TOKEN_PAYLOAD,
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

  // Validate this is actually a refresh token
  if (payload.type !== 'refresh') {
    return oauthError(400, 'invalid_grant', 'Invalid token type', 'token/refresh', { type: payload.type });
  }

  const { accessToken, identity } = payload;

  // Issue new access token and rotate refresh token, carrying identity forward
  // so it survives the token's full refresh lifetime.
  const newAccessTokenJWE = await createJWE({ accessToken, ...(identity ? { identity } : {}) } satisfies ACCESS_TOKEN_PAYLOAD, '48h');
  const newRefreshTokenJWE = await createJWE(
    { accessToken, type: 'refresh', ...(identity ? { identity } : {}) } satisfies REFRESH_TOKEN_PAYLOAD,
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
