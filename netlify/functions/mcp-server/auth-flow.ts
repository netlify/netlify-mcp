import { HandlerResponse } from "@netlify/functions";
import { createHash } from "crypto";
import { createJWE, decryptJWE, getOAuthIssuer } from "./utils.ts";
import { debugLog } from "./logging.ts";


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
}

interface REFRESH_TOKEN_PAYLOAD {
  accessToken: string;
  type: 'refresh';
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
  console.error('oauth error', {
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
  
  debugLog('authorize start', { client_id: params.get('client_id'), redirect_uri: params.get('redirect_uri'), scope: params.get('scope') });

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

    const rediredctURL = new URL(validatedState.redirect_uri);

    if(validatedState.state) {
      rediredctURL.searchParams.set('state', validatedState.state);
    }

    // RFC 9207: Include iss parameter in authorization response
    rediredctURL.searchParams.set('iss', getOAuthIssuer());

    // TODO: future, we will add specific tools and other context to this for
    // downstream validation
    debugLog('server redirect: issuing authorization code', { client_id: validatedState.client_id, redirect_uri: validatedState.redirect_uri, scope: validatedState.scope });

    const jwe = await createJWE({state: validatedState, accessToken: token} satisfies CODE_JWE_PAYLOAD);

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


export async function handleCodeExchange(req: Request): Promise<HandlerResponse> {

  const body = await req.text();

  // get data from application/x-www-form-urlencoded body
  const bodyParams = new URLSearchParams(body);
  const grantType = bodyParams.get('grant_type') || 'authorization_code';

  debugLog('token exchange', { grantType, client_id: bodyParams.get('client_id'), hasAuthHeader: !!req.headers.get('authorization') });

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

  const { accessToken, state } = decryptedCode;

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

  const accessTokenJWE = await createJWE({accessToken}, '48h');

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
      { accessToken, type: 'refresh' } satisfies REFRESH_TOKEN_PAYLOAD,
      '7d' // refresh token valid for 7 days
    );
    tokenResponse.refresh_token = refreshTokenJWE;
  }

  debugLog('token issued', { client_id: clientId, hasOfflineAccess, refreshTokenIssued: hasOfflineAccess });

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

  const { accessToken } = payload;

  // Issue new access token and rotate refresh token
  const newAccessTokenJWE = await createJWE({ accessToken }, '48h');
  const newRefreshTokenJWE = await createJWE(
    { accessToken, type: 'refresh' } satisfies REFRESH_TOKEN_PAYLOAD,
    '7d'
  );

  debugLog('refresh token grant: issued new tokens', {});

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
