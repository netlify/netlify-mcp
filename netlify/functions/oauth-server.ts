import serverless from "serverless-http";
import type { Context, Config, Handler, HandlerResponse, HandlerEvent, HandlerContext } from "@netlify/functions";
import { toFetchResponse, toReqRes } from "fetch-to-node";
import { Provider } from "oidc-provider";
import type { Configuration } from "oidc-provider";

function getIssuer(): string {
  // Use the environment variable or default to localhost
  return process.env.OAUTH_ISSUER || 'http://localhost:8888';
}

// MCP-compliant OAuth2/OIDC server configuration
// Minimal MCP-compliant OAuth2/OIDC server configuration
const configuration: Configuration = {
  // BROKEN:Supported OAuth2 grant types
  // grantTypes: ['authorization_code', 'refresh_token', 'client_credentials'],

  // Only allow Authorization Code flow
  responseTypes: ['code'],
  // Supported scopes
  scopes: ['openid', 'offline_access', 'read', 'write'],
  // OIDC claims (minimal)
  claims: {
    openid: ['sub'],
    // Add more claims if needed
  },
  // Token lifetimes
  ttl: {
    AuthorizationCode: 60,      // 1 minute
    AccessToken: 300,           // 5 minutes
    RefreshToken: 24 * 3600     // 24 hours
  },
  // Enforce PKCE for all clients
  pkce: {
    required: () => false, // TODO: Disable PKCE for simplicity, enable in production
  },
  // Enable dynamic client registration, introspection, revocation
  features: {
    registration: { enabled: true },
    registrationManagement: { enabled: true },
    introspection: { enabled: true },
    revocation: { enabled: true },
    userinfo: { enabled: false }, // Enable userinfo endpoint
  },
  // Example static client for testing (remove in production)
  clients: [
    // {
    //   client_id: 'test-confidential-client',
    //   client_secret: 'supersecret',
    //   grant_types: ['authorization_code', 'refresh_token'],
    //   redirect_uris: ['https://app.example.com/callback'],
    //   token_endpoint_auth_method: 'client_secret_basic'
    // }
  ],

  routes: {
    authorization: '/oauth-server/auth',
    backchannel_authentication: '/oauth-server/backchannel',
    code_verification: '/oauth-server/device',
    device_authorization: '/oauth-server/device/auth',
    end_session: '/oauth-server/session/end',
    introspection: '/oauth-server/token/introspection',
    jwks: '/oauth-server/jwks',
    pushed_authorization_request: '/oauth-server/request',
    registration: '/oauth-server/reg',
    revocation: '/oauth-server/token/revocation',
    token: '/oauth-server/token',
    userinfo: '/oauth-server/me'
  },

  // For a real deployment, add findAccount, adapter, and interaction config
  renderError(ctx, out, error) {
    console.error('OIDC Provider Error:', error);
    ctx.body = {
      error: 'server_error',
      error_description: 'An internal server error occurred'
    };
    ctx.status = 500;
  },
};

function getParsedUrl(req: HandlerEvent, overrideUrl?: string): URL {
  return new URL(overrideUrl ?? req.rawUrl, getIssuer() || 'https://unknown.example.com');
}

function prepRequest(req: HandlerEvent) {
  const reqHeaders = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      reqHeaders.set(key, value);
    }
  }
  const request = new Request(req.rawUrl, {
    method: req.httpMethod,
    headers: reqHeaders,
    body: req.body
  });

  const { req: nodeReq, res: nodeRes } = toReqRes(request, {
    ctx: {
      req: {
        originalUrl: req.rawUrl,
        url: req.rawUrl,
      }
    }
  });

  return { nodeReq, nodeRes, parsedUrl: getParsedUrl(req) };
}

function urlsToHTTP(payload: Record<string, any> | string, origin: string): Record<string, any> | string {
  let text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const {host: targetHost, origin: targetOrigin} = new URL(origin);
  text = text.replace(/(https?:\/\/[^"]+)/g, (match, url) => {

    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.origin.endsWith(targetHost)) {
        return parsedUrl.toString().replace(parsedUrl.origin, targetOrigin);
      }
    } catch {}
    return match; // Return original match if not valid or not same origin
  });
  return typeof payload === 'string' ? text : JSON.parse(text);
}

function headersToHeadersObject(headers: Headers | Record<string, string>): Headers {
  const headersObj = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string' || typeof value === 'number') {
      headersObj.set(key, value.toString());
    }
  }
  return headersObj;
}

function addCORSHeaders(response: HandlerResponse): HandlerResponse {
  const respHeaders = headersToHeadersObject(response.headers as Record<string, string> | Headers || {});
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('Access-Control-Allow-Methods', '*');
  respHeaders.set('Access-Control-Allow-Headers', '*');
  response.headers = Object.fromEntries(respHeaders.entries());
  return response;
}

interface InvocationOverrides {
  url?: string;
}
async function invokeOIDCProvider(req: HandlerEvent, context: HandlerContext, overrides?: InvocationOverrides): Promise<HandlerResponse> {
  const updatedReq = {...req};

  if (overrides?.url) {
    const oUrl = getParsedUrl(req, overrides.url); // Validate URL
    updatedReq.rawUrl = oUrl.toString();
    updatedReq.path = oUrl.pathname;
    updatedReq.rawQuery = oUrl.search;
    updatedReq.queryStringParameters = Object.fromEntries(oUrl.searchParams.entries());
  }

  const oidcProvider = new Provider(getIssuer(), configuration);
  const wrappedAppInvoker = serverless(oidcProvider)
  const response = await wrappedAppInvoker(updatedReq, context) as HandlerResponse;


  const respHeaders = headersToHeadersObject(req.headers as Record<string, string>);
  respHeaders.delete('content-length'); // Remove content-length to avoid issues with streaming responses

  response.headers = Object.fromEntries(respHeaders.entries());

  return response;
}


export const handler: Handler = async (req, context) => {

  console.log('Received request:', req.httpMethod, req.rawUrl);

  if(req.httpMethod === 'OPTIONS') {
    // Handle CORS preflight requests
    const response: HandlerResponse = {
      statusCode: 204,
      body: ''
    };
    return addCORSHeaders(response);
  }


  const parsedUrl = getParsedUrl(req);
  const invocationOverrides: InvocationOverrides = {};

  const getProtectedResource = parsedUrl.pathname.endsWith('/.well-known/oauth-protected-resource');
  const getAuthorizationServer = parsedUrl.pathname.endsWith('/.well-known/oauth-authorization-server');

  console.log( 'Request received:', req.httpMethod, parsedUrl.pathname, {getProtectedResource, getAuthorizationServer} );

  if (getProtectedResource || getAuthorizationServer) {

    invocationOverrides.url = '/.well-known/openid-configuration';
    const response = await invokeOIDCProvider(req, context, invocationOverrides);

    let oidcConfig = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;

    if(getProtectedResource){
      oidcConfig.resource = getIssuer();
    }

    oidcConfig = urlsToHTTP(oidcConfig, getIssuer());

    response.body = JSON.stringify(oidcConfig);

    addCORSHeaders(response);

    return response;
  }

  const resp = await invokeOIDCProvider(req, context, invocationOverrides);

  addCORSHeaders(resp);
  if(resp.body && resp.body.includes('http')){
    resp.body = urlsToHTTP(resp.body, getIssuer()) as string;
  }

  return resp;
}
