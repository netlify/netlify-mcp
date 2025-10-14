import { HandlerResponse } from "@netlify/functions";
import { createHash } from "crypto";
import { createJWE, decryptJWE, getOAuthIssuer } from "./utils.ts";

interface CODE_JWE_PAYLOAD {
  state: Record<string, any>;
  accessToken: string;
}

const NTL_AUTH_CLIENT_ID = process.env.NTL_AUTH_CLIENT_ID || '';


export async function handleAuthStart(req: Request): Promise<HandlerResponse>{

  const parsedUrl = new URL(req.url);
  const params = parsedUrl.searchParams;
  const requiredParams = ['response_type', 'client_id', 'redirect_uri',];
  const optionalParams = ['state','scope', 'nonce', 'code_challenge', 'code_challenge_method'];
  
  const missingParams = requiredParams.filter(param => !params.get(param));
  if (missingParams.length > 0) {
    // RFC 9207: Return error via redirect with iss parameter if redirect_uri is available
    const redirectUri = params.get('redirect_uri');
    if (redirectUri) {
      try {
        const errorRedirectUrl = new URL(redirectUri);
        errorRedirectUrl.searchParams.set('error', 'invalid_request');
        errorRedirectUrl.searchParams.set('error_description', `Missing required parameters: ${missingParams.join(', ')}`);
        errorRedirectUrl.searchParams.set('iss', getOAuthIssuer());
        const state = params.get('state');
        if (state) {
          errorRedirectUrl.searchParams.set('state', state);
        }
        return {
          statusCode: 302,
          headers: { 'Location': errorRedirectUrl.toString() },
          body: ''
        };
      } catch (e) {
        // Invalid redirect_uri, fall through to JSON error
      }
    }
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'invalid_request',
        error_description: `Missing required parameters: ${missingParams.join(', ')}`
      }),
    };
  }

  const paramsObj: Record<string, string> = {};
  ([] as any[]).concat(requiredParams, optionalParams).filter(param => {
    if(params.get(param)){
      paramsObj[param] = params.get(param) as string;
    }
  });

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
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'invalid_request',
        error_description: `Missing required parameters: ${!initState ? 'init-state' : ''} ${!token ? 'token' : ''}`.trim()
      }),
    };
  }

  try {
    const stateObj = JSON.parse(Buffer.from(initState, 'base64').toString('utf-8'));

    const rediredctURL = new URL(stateObj.redirect_uri);

    if(stateObj.state) {
      rediredctURL.searchParams.set('state', stateObj.state);
    }

    // RFC 9207: Include iss parameter in authorization response
    rediredctURL.searchParams.set('iss', getOAuthIssuer());

    // TODO: future, we will add specific tools and other context to this for
    // downstream validation
    const jwe = await createJWE({state: stateObj, accessToken: token} satisfies CODE_JWE_PAYLOAD);

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
    
    // RFC 9207: Try to return error via redirect with iss parameter if possible
    try {
      const stateObj = JSON.parse(Buffer.from(initState || '', 'base64').toString('utf-8'));
      if (stateObj.redirect_uri) {
        const errorRedirectUrl = new URL(stateObj.redirect_uri);
        errorRedirectUrl.searchParams.set('error', 'invalid_request');
        errorRedirectUrl.searchParams.set('error_description', 'Invalid init-state parameter');
        errorRedirectUrl.searchParams.set('iss', getOAuthIssuer());
        if (stateObj.state) {
          errorRedirectUrl.searchParams.set('state', stateObj.state);
        }
        return {
          statusCode: 302,
          headers: { 'Location': errorRedirectUrl.toString() },
          body: ''
        };
      }
    } catch (e) {
      // Could not parse state, fall through to JSON error
    }
    
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'invalid_request',
        error_description: `Invalid init-state parameter`
      }),
    };
  }
}


export async function handleCodeExchange(req: Request): Promise<HandlerResponse> {
  
  const body = await req.text();

  // get data from application/x-www-form-urlencoded body
  const bodyParams = new URLSearchParams(body);

  const code = bodyParams.get('code');
  const codeVerifier = bodyParams.get('code_verifier');

  if(!code) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'invalid_request',
        error_description: 'Missing required parameter: code'
      }),
    };
  }

  const {accessToken, state} = (await decryptJWE(code)) as any as CODE_JWE_PAYLOAD;  

  if(codeVerifier && !isPKCEValid(codeVerifier, state.code_challenge, state.code_challenge_method)) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'invalid_grant',
        error_description: 'PKCE verification failed',
      }),
    };
  }

  const accessTokenJEW = await createJWE({accessToken}, '48h');

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
    body: JSON.stringify({
      "access_token": accessTokenJEW,
      // "refresh_token": "REFRESH_TOKEN",
      "token_type": "Bearer",
      "expires_in": 3600
    })
  }
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