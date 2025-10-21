import serverless from "serverless-http";
import type { Handler, HandlerResponse, HandlerEvent, HandlerContext } from "@netlify/functions";
import { Provider } from "oidc-provider";
import type { Configuration, ClientMetadata } from "oidc-provider";
import { handleAuthStart, handleClientSideAuthExchange, handleCodeExchange, handleServerSideAuthRedirect } from "./mcp-server/auth-flow.ts";
import { getOAuthIssuer, addCommonHeadersToHandlerResp, headersToHeadersObject, getParsedUrl, urlsToHTTP } from "./mcp-server/utils.ts";

const authorizationEndpointPath = '/oauth-server/auth';
const tokenEndpointPath = '/oauth-server/token';
const clientRedirectPath = '/oauth-server/client-redirect';
const serverRedirectPath = '/oauth-server/server-redirect';
const registrationEndpointPath = '/oauth-server/reg';

// Static OAuth clients - add your pre-configured clients here
const staticClients: ClientMetadata[] = [
  // Azure AI Foundry wants to do authentication on customer behalf but does 
  // not support dynamic client registration yet. They asked to have us provision a dedicated
  // client for them. Here are the details they provided.
  // Point of contacts for Azure AI Foundry
  // zhuoqunli@microsoft.com 
  // AzureToolsCatalog@microsoft.com
  {
    client_id: 'azure-ai-foundry',
    client_secret: Netlify.env.get('CLIENT_SECRET_AZURE_AI_FOUNDRY'), // Use secure secrets in production
    redirect_uris: [
      'https://global.consent.azure-apim.net/redirect/foundrynetlifymcp',
      'https://global-test.consent.azure-apim.net/redirect/foundrynetlifymcp'
    ],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
  },
  // Add more static clients as needed
];

// In-memory storage for dynamically registered clients
const dynamicClients = new Map<string, ClientMetadata>();

// Adapter to support both static and dynamic clients
class ClientAdapter {
  constructor(private name: string) {}

  async upsert(id: string, payload: any, expiresIn?: number) {
    if (this.name === 'Client') {
      const staticClient = staticClients.find(c => c.client_id === id);
      if (!staticClient) {
        console.log('Registering dynamic client:', id, payload, expiresIn);
        dynamicClients.set(id, payload);
      }
    }
  }

  async find(id: string) {
    if (this.name === 'Client') {
      // Check static clients first
      const staticClient = staticClients.find(c => c.client_id === id);
      if (staticClient) {
        return staticClient;
      }
      // Then check dynamic clients
      return dynamicClients.get(id);
    }
    return undefined;
  }

  async findByUserCode(userCode: string) {
    return undefined;
  }

  async findByUid(uid: string) {
    return undefined;
  }

  async destroy(id: string) {
    if (this.name === 'Client') {
      dynamicClients.delete(id);
    }
  }

  async revokeByGrantId(grantId: string) {}

  async consume(id: string) {}
}

// MCP-compliant OAuth2/OIDC server configuration
// Minimal MCP-compliant OAuth2/OIDC server configuration
const configuration: Configuration = {
  adapter: ClientAdapter,

  // Only allow Authorization Code flow
  responseTypes: ['code'],
  // Supported scopes
  scopes: [
    'openid', 
    'offline_access', 
    'read', 
    'write', 
    'claudeai' // temp until this bug is fixed: https://github.com/modelcontextprotocol/modelcontextprotocol/issues/653
  ],
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
    registration: registrationEndpointPath,
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

  console.log('oauth', {reqMethod: req.httpMethod, url: req.rawUrl});

  // Handle CORS preflight requests
  if(req.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      body: ''
    };
  }

  const parsedUrl = getParsedUrl(req);
  let reqObj = new Request(req.rawUrl, {
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
  const isRegistrationPath = parsedUrl.pathname.endsWith(registrationEndpointPath);


  if(isRegistrationPath){
    console.log(JSON.stringify(req.body))
  }

  // we want OIDC discovery to handle these paths
  if (getProtectedResource || getAuthorizationServer) {

    invocationOverrides.url = '/.well-known/openid-configuration';
    const response = await invokeOIDCProvider(req, context, invocationOverrides);

    let oidcConfig = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;

    if(getProtectedResource){
      oidcConfig.resource = new URL('/mcp', getOAuthIssuer()).toString();
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

  // ensure requests have a proper application type
  // if(isRegistrationPath){
  //   const regInfo = JSON.parse(req.body || '{}');
  //   if(regInfo && !regInfo.application_type && Array.isArray(regInfo.redirect_uris)){
  //     regInfo.redirect_uris.some((uri: string) => {
  //       if(uri.startsWith('http')){
  //         regInfo.application_type = 'web';
  //         return true;
  //       }
  //       return false;
  //     });

  //     if(regInfo.application_type !== 'web'){
  //       regInfo.application_type = 'native';
  //     }
      
  //     reqObj.headers.delete('content-length');
  //     reqObj = new Request(req.rawUrl, {
  //       method: reqObj.method,
  //       headers: reqObj.headers,
  //       body: JSON.stringify(regInfo),
  //     });
  //     req.headers = Object.fromEntries(reqObj.headers.entries());
  //     req.body = JSON.stringify(regInfo);

  //     console.log('updated', JSON.stringify(req, null, 2));
  //   }
  // }

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
  return resp ? addCommonHeadersToHandlerResp(resp) : {
    statusCode: 500,
    body: JSON.stringify({ error: 'Internal Server Error' }),
    headers: { 'Content-Type': 'application/json' }
  };
}
