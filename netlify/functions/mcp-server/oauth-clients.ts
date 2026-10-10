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
];

export function getClientById(id: string | null | undefined): StaticClient | undefined {
  if (!id) {
    return undefined;
  }

  return staticClients.find((client) => client.client_id === id);
}
