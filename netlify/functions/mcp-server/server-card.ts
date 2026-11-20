import { getPackageVersion } from "../../../src/utils/version.ts";
import { RESOURCE_PATH } from "./oauth-config.ts";

// MCP Server Card (experimental ext-server-card, tracking SEP-2127): a static
// document describing this server well enough for a client or crawler to
// discover and brand it without connecting. Tools/resources are deliberately
// absent — the extension leaves those to the runtime list operations.
// https://github.com/modelcontextprotocol/ext-server-card
export const SERVER_CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';

// The extension's recommended location is `<streamable-http-url>/server-card`.
export const SERVER_CARD_PATH = `${RESOURCE_PATH}/server-card`;

// Built from the request origin rather than OAUTH_ISSUER: this deployment is
// reachable on more than one hostname (mcp.netlify.com and
// netlify-mcp.netlify.app), and the card must name the exact address a client
// fetched it from so the card matches the server it connects to.
export function buildServerCard(origin: string) {
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: 'com.netlify/mcp',
    title: 'Netlify',
    // The extension caps description at 100 characters.
    description: 'Create, deploy, and manage Netlify projects, deploys, environment variables, forms, and teams.',
    version: getPackageVersion(),
    websiteUrl: 'https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/',
    repository: { url: 'https://github.com/netlify/netlify-mcp', source: 'github' },
    icons: [
      { src: 'https://www.netlify.com/favicon/icon.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
      { src: 'https://www.netlify.com/favicon/apple-touch-icon.png', mimeType: 'image/png', sizes: ['180x180'] },
    ],
    remotes: [{ type: 'streamable-http', url: new URL(RESOURCE_PATH, origin).toString() }],
  };
}
