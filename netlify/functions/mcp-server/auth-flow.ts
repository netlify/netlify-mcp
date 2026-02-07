import { HandlerResponse } from "@netlify/functions";
import { createHash } from "crypto";
import { createJWE, decryptJWE, getOAuthIssuer } from "./utils.ts";
import { getClientById } from "./oauth-clients.ts";

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

function oauthError(statusCode: number, error: string, errorDescription: string): HandlerResponse {
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
  
  const missingParams = AUTH_REQUIRED_PARAMS.filter(param => !params.get(param));
  if (missingParams.length > 0) {
    return oauthError(400, 'invalid_request', `Missing required parameters: ${missingParams.join(', ')}`);
  }

  const responseType = params.get('response_type');
  if (responseType !== 'code') {
    return oauthError(400, 'unsupported_response_type', 'Only response_type=code is supported');
  }

  const codeChallengeMethod = params.get('code_challenge_method');
  if (codeChallengeMethod !== 'S256') {
    return oauthError(400, 'invalid_request', 'code_challenge_method must be S256');
  }

  const clientId = params.get('client_id') as string;
  const redirectUri = params.get('redirect_uri') as string;
  const codeChallenge = params.get('code_challenge') as string;

  const client = getClientById(clientId);
  if (!client) {
    return oauthError(400, 'invalid_client', 'Unknown client_id');
  }

  if (!Array.isArray(client.redirect_uris) || !client.redirect_uris.includes(redirectUri)) {
    return oauthError(400, 'invalid_request', 'redirect_uri must exactly match a registered redirect URI');
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
    return oauthError(400, 'invalid_request', `Missing required parameters: ${!initState ? 'init-state' : ''} ${!token ? 'token' : ''}`.trim());
  }

  try {
    const stateObj = JSON.parse(Buffer.from(initState, 'base64').toString('utf-8')) as Partial<AUTH_REQUEST_STATE>;

    if (!stateObj.client_id) {
      return oauthError(400, 'invalid_request', 'Missing required parameter in init-state: client_id');
    }
    if (!stateObj.redirect_uri) {
      return oauthError(400, 'invalid_request', 'Missing required parameter in init-state: redirect_uri');
    }
    if (!stateObj.code_challenge) {
      return oauthError(400, 'invalid_request', 'Missing required parameter in init-state: code_challenge');
    }
    if (stateObj.code_challenge_method !== 'S256') {
      return oauthError(400, 'invalid_request', 'Invalid code_challenge_method in init-state');
    }
    if (stateObj.response_type !== 'code') {
      return oauthError(400, 'invalid_request', 'Invalid response_type in init-state');
    }

    const client = getClientById(stateObj.client_id);
    if (!client) {
      return oauthError(400, 'invalid_client', 'Unknown client_id');
    }
    if (!Array.isArray(client.redirect_uris) || !client.redirect_uris.includes(stateObj.redirect_uri)) {
      return oauthError(400, 'invalid_request', 'redirect_uri must exactly match a registered redirect URI');
    }

    const validatedState: AUTH_REQUEST_STATE = {
      response_type: 'code',
      client_id: stateObj.client_id,
      redirect_uri: stateObj.redirect_uri,
      code_challenge: stateObj.code_challenge,
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
    
    console.error('Failed to parse init-state:', error);
    return oauthError(400, 'invalid_request', 'Invalid init-state parameter');
  }
}


export async function handleCodeExchange(req: Request): Promise<HandlerResponse> {

  const body = await req.text();

  // get data from application/x-www-form-urlencoded body
  const bodyParams = new URLSearchParams(body);
  const grantType = bodyParams.get('grant_type') || 'authorization_code';

  // Handle refresh_token grant type
  if (grantType === 'refresh_token') {
    return handleRefreshTokenGrant(bodyParams);
  }

  // Handle authorization_code grant type
  const requiredParams = ['code', 'client_id', 'redirect_uri', 'code_verifier'];
  const missingParams = requiredParams.filter(param => !bodyParams.get(param));
  if(missingParams.length > 0) {
    return oauthError(400, 'invalid_request', `Missing required parameters: ${missingParams.join(', ')}`);
  }

  const code = bodyParams.get('code') as string;
  const clientId = bodyParams.get('client_id') as string;
  const redirectUri = bodyParams.get('redirect_uri') as string;
  const codeVerifier = bodyParams.get('code_verifier') as string;

  const client = getClientById(clientId);
  if (!client) {
    return oauthError(400, 'invalid_client', 'Unknown client_id');
  }

  if (!Array.isArray(client.redirect_uris) || !client.redirect_uris.includes(redirectUri)) {
    return oauthError(400, 'invalid_grant', 'redirect_uri is not valid for client_id');
  }

  let decryptedCode: CODE_JWE_PAYLOAD;
  try {
    decryptedCode = (await decryptJWE(code)) as any as CODE_JWE_PAYLOAD;
  } catch (error) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'invalid_grant',
        error_description: 'Invalid or expired authorization code',
      }),
    };
  }

  const { accessToken, state } = decryptedCode;

  if (state.client_id !== clientId || state.redirect_uri !== redirectUri) {
    return oauthError(400, 'invalid_grant', 'client_id or redirect_uri does not match authorization code');
  }

  if (!state.code_challenge || state.code_challenge_method !== 'S256') {
    return oauthError(400, 'invalid_grant', 'Authorization code is missing PKCE binding');
  }

  if(!isPKCEValid(codeVerifier, state.code_challenge, state.code_challenge_method)) {
    return oauthError(400, 'invalid_grant', 'PKCE verification failed');
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
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'invalid_request',
        error_description: 'Missing required parameter: refresh_token'
      }),
    };
  }

  let payload: REFRESH_TOKEN_PAYLOAD;
  try {
    payload = (await decryptJWE(refreshToken)) as any as REFRESH_TOKEN_PAYLOAD;
  } catch (error) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'invalid_grant',
        error_description: 'Invalid or expired refresh token'
      }),
    };
  }

  // Validate this is actually a refresh token
  if (payload.type !== 'refresh') {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'invalid_grant',
        error_description: 'Invalid token type'
      }),
    };
  }

  const { accessToken } = payload;

  // Issue new access token and rotate refresh token
  const newAccessTokenJWE = await createJWE({ accessToken }, '48h');
  const newRefreshTokenJWE = await createJWE(
    { accessToken, type: 'refresh' } satisfies REFRESH_TOKEN_PAYLOAD,
    '7d'
  );

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
