// Serves the MCP Server Card (see mcp-server/server-card.ts). A separate,
// dependency-light function so a discovery crawler fetching the card neither
// pays the MCP function's cold start nor hits its auth gate.
import type { Config } from '@netlify/functions';
import { buildServerCard } from './mcp-server/server-card.ts';

export default async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      },
    });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } });
  }

  const card = buildServerCard(new URL(req.url).origin);
  return new Response(req.method === 'HEAD' ? null : JSON.stringify(card, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/mcp-server-card+json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
    },
  });
};

export const config: Config = {
  // The extension's recommended location (SERVER_CARD_PATH), plus the
  // single-server well-known path that some scanners (and older drafts) still
  // probe. Literals only: Netlify reads `config` statically at bundle time and
  // rejects anything it can't evaluate, such as an imported constant.
  path: ['/mcp/server-card', '/.well-known/mcp/server-card.json'],
};
