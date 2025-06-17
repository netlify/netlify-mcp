import serverless from "serverless-http";
import type { Handler, HandlerResponse, HandlerEvent, HandlerContext } from "@netlify/functions";
import { Provider } from "oidc-provider";
import type { Configuration } from "oidc-provider";
import { handleAuthStart, handleClientSideAuthExchange, handleCodeExchange, handleServerSideAuthRedirect } from "./mcp-server/auth-flow.js";
import { getOAuthIssuer, addCORSHeaders, headersToHeadersObject, getParsedUrl, urlsToHTTP } from "./mcp-server/utils.js";

const authorizationEndpointPath = '/oauth-server/auth';
const tokenEndpointPath = '/oauth-server/token';
const clientRedirectPath = '/oauth-server/client-redirect';
const serverRedirectPath = '/oauth-server/server-redirect';

// MCP-compliant OAuth2/OIDC server configuration
// Minimal MCP-compliant OAuth2/OIDC server configuration
const configuration: Configuration = {

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
    required: () => true,
  },
  
  // Enable dynamic client registration, introspection, revocation
  features: {
    registration: { enabled: true },
    registrationManagement: { enabled: true },
    deviceFlow: { enabled: true },

    introspection: { enabled: false }, // TODO: future Enable introspection endpoint
    revocation: { enabled: true },
    userinfo: { enabled: false }, // TODO: future Enable userinfo endpoint
  },

  // we don't use all of these but we prefix them to ensure our fn handles them
  routes: {
    authorization: authorizationEndpointPath,
    backchannel_authentication: '/oauth-server/backchannel',
    code_verification: '/oauth-server/device',
    device_authorization: '/oauth-server/device/auth',
    end_session: '/oauth-server/session/end',
    introspection: '/oauth-server/token/introspection',
    jwks: '/404-jwks', // 404 until we can setup properly '/oauth-server/jwks',
    pushed_authorization_request: '/oauth-server/request',
    registration: '/oauth-server/reg',
    revocation: '/oauth-server/token/revocation',
    token: tokenEndpointPath,
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

  const oidcProvider = new Provider(getOAuthIssuer(), configuration);

  const wrappedAppInvoker = serverless(oidcProvider)
  const response = await wrappedAppInvoker(updatedReq, context) as HandlerResponse;


  const respHeaders = headersToHeadersObject(req.headers as Record<string, string>);
  respHeaders.delete('content-length'); // Remove content-length to avoid issues with streaming responses

  response.headers = Object.fromEntries(respHeaders.entries());

  return response;
}


const oAuthHandler: Handler = async (req, context) => {

  // Handle CORS preflight requests
  if(req.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      body: ''
    };
  }

  const parsedUrl = getParsedUrl(req);
  const reqObj = new Request(req.rawUrl, {
    method: req.httpMethod,
    headers: headersToHeadersObject(req.headers as Record<string, string>),
    body: req.body || null
  });
  const invocationOverrides: InvocationOverrides = {};

  const getProtectedResource = parsedUrl.pathname.endsWith('/.well-known/oauth-protected-resource');
  const getAuthorizationServer = parsedUrl.pathname.endsWith('/.well-known/oauth-authorization-server');
  const isAuthPath = parsedUrl.pathname.endsWith(authorizationEndpointPath);
  const isClientRedirectPath = parsedUrl.pathname.endsWith(clientRedirectPath);
  const isServerRedirectPath = parsedUrl.pathname.endsWith(serverRedirectPath);
  const isCodeExchangePath = parsedUrl.pathname.endsWith(tokenEndpointPath);

  // we want OIDC discovery to handle these paths
  if (getProtectedResource || getAuthorizationServer) {

    invocationOverrides.url = '/.well-known/openid-configuration';
    const response = await invokeOIDCProvider(req, context, invocationOverrides);

    let oidcConfig = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;

    if(getProtectedResource){
      oidcConfig.resource = getOAuthIssuer();
    }

    oidcConfig = urlsToHTTP(oidcConfig, getOAuthIssuer());

    response.body = JSON.stringify(oidcConfig);

    return response;
  }

  // where we expclicitly manage the auth flow, we handle the paths directly
  if(isAuthPath) {
    return await handleAuthStart(reqObj);
  }else if(isClientRedirectPath) {
    // Handle client redirect after authorization
    return await handleClientSideAuthExchange();
  }else if(isServerRedirectPath) {
    // Handle server redirect after authorization
    return await handleServerSideAuthRedirect(reqObj);
  }else if(isCodeExchangePath){
    return await handleCodeExchange(reqObj);
  }

  // allow catch all for these paths to be handled by the OIDC provider
  const resp = await invokeOIDCProvider(req, context, invocationOverrides);

  if(resp.statusCode === 400){
    console.error({
      error: 'Bad Request',
      message: 'Invalid request to OIDC provider',
      statusCode: resp.statusCode,
      body: resp.body,
      headers: headersToHeadersObject(resp.headers as Record<string, string> || {})
    })
  }

  if(resp.body && resp.body.includes('http')){
    resp.body = urlsToHTTP(resp.body, getOAuthIssuer()) as string;
  }

  return resp;
}


export const handler: Handler = async (req, context) => {
  const resp = await oAuthHandler(req, context);
  return resp ? addCORSHeaders(resp) : {
    statusCode: 500,
    body: JSON.stringify({ error: 'Internal Server Error' }),
    headers: { 'Content-Type': 'application/json' }
  };
}
