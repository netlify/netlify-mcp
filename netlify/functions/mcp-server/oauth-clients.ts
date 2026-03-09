import type { ClientMetadata } from "oidc-provider";

// Static OAuth clients - add your pre-configured clients here
export const staticClients: ClientMetadata[] = [
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

export function getClientById(id: string | null | undefined): ClientMetadata | undefined {
  if (!id) {
    return undefined;
  }

  return staticClients.find((client) => client.client_id === id);
}
