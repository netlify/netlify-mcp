// Shape of a pre-provisioned ("static") OAuth client. These are the fields
// resolveClient (client-registry.ts) reads; kept local so this module has no
// dependency on any OAuth/OIDC library.
export interface StaticClient {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope?: string;
}

// Static OAuth clients - add your pre-configured clients here
export const staticClients: StaticClient[] = [
  // Azure AI Foundry wants to do authentication on customer behalf but does
  // not support dynamic client registration yet. They asked to have us provision a dedicated
  // client for them. Here are the details they provided.
  // Point of contacts for Azure AI Foundry
  // zhuoqunli@microsoft.com
  // AzureToolsCatalog@microsoft.com
  {
    // oauth app name "Azure AI Foundry"
    client_id: "yncg92fdmoCfvrPSIbNH9ihx9oI5iFFoKqTY7sVQkEA",
    client_secret:
      process.env.CLIENT_SECRET_AZURE_AI_FOUNDRY ||
      "supersecret!!!!!321aasdf23123cdfdSDFSKL;;;8",
    redirect_uris: ["https://global.consent.azure-apim.net/redirect/foundrynetlifymcp"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  },
  {
    // oauth app name "Azure AI Foundry Testing"
    client_id: "BHsAsy2hsx4NLRthhSVAA2IQ0W7d72H8o2fevaVqyaE",
    client_secret:
      process.env.CLIENT_SECRET_AZURE_AI_FOUNDRY_TESTING ||
      "supersecret!!!!!321aasdf23123cdfdSDFSKL;;;8",
    redirect_uris: ["https://global-test.consent.azure-apim.net/redirect/foundrynetlifymcp"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  },
  // ChatGPT registered once, through the dynamic registration that predates the
  // stateless client_id (2e5b221), and reuses that client_id for every user
  // (OpenAI runs DCR once per MCP server connection and keeps the client). The
  // server cannot resolve it any more, yet it carried about half of all
  // production logins in Sep-Oct 2026, so it is pinned here with the one
  // redirect_uri those requests carry (OpenAI's stable connector redirect).
  // Public PKCE client: no secret was ever issued.
  {
    // ChatGPT connector ("Netlify" MCP server)
    client_id: "2m93QbON-vPRJMMIGA_MEzG1fkejj4JNAgb97ZC3gPd",
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  },
];

export function getClientById(id: string | null | undefined): StaticClient | undefined {
  if (!id) {
    return undefined;
  }

  return staticClients.find((client) => client.client_id === id);
}
