import type { Context } from '@netlify/edge-functions';
import { isVerboseLogging, maskToken, safeBodySummary, mcpBodySummary } from '../functions/mcp-server/logging.ts';
import { log, withLogContext, newRequestId, getDeployId } from '../functions/mcp-server/logger.ts';

// Catch-all request/response logger. Runs in front of every request (declared
// first in netlify.toml so it wraps the proxy edge function and all regular
// functions), logging the request body and the response body for every
// interaction regardless of path. Gated behind MCP_VERBOSE_LOGGING so it can be
// turned off — it buffers bodies and adds latency, so it's a debugging switch,
// not something to leave on in steady state.

const MAX_BODY = 8000;          // truncate logged bodies to keep logs readable
const MAX_BUFFER = 200_000;     // don't buffer responses larger than this

function truncate(s: string): string {
  return s.length > MAX_BODY ? `${s.slice(0, MAX_BODY)}…(${s.length} bytes total)` : s;
}

export default async (request: Request, context: Context) => {
  // Pass through untouched when verbose logging is disabled.
  if (!isVerboseLogging()) {
    return;
  }

  const url = new URL(request.url);
  const path = url.pathname;
  // Data-bearing paths carry user values, not protocol metadata:
  //  - /mcp: tool call arguments and tool results
  //  - /proxy: raw Netlify API request/response payloads
  // We never log their body values. /mcp gets a value-free shape summary (tool
  // name + argument names); /proxy is omitted entirely. Only OAuth/discovery
  // paths keep full (redacted) body logging, where it's useful for debugging the
  // auth flow and secrets are stripped by safeBodySummary.
  const isMcp = path === '/mcp' || path.startsWith('/mcp/');
  const isProxy = path.startsWith('/proxy/');

  return withLogContext(
    {
      service: 'edge',
      requestId: newRequestId(),
      deployId: getDeployId(request.headers),
      httpMethod: request.method,
      path,
    },
    async () => {
      // Read the request body via a clone so the original is left intact for
      // downstream handlers (context.next()).
      let reqBody = '';
      try {
        if (request.body) {
          const text = await request.clone().text();
          if (isMcp) {
            reqBody = JSON.stringify(mcpBodySummary(text));
          } else if (isProxy) {
            reqBody = `<omitted: proxied API request (${text.length} bytes)>`;
          } else {
            // OAuth/discovery: redact known secrets, then truncate (redact-first
            // so truncation can never split around a secret).
            reqBody = truncate(JSON.stringify(safeBodySummary(text)));
          }
        }
      } catch (err) {
        reqBody = `<unreadable request body: ${err instanceof Error ? err.message : String(err)}>`;
      }

      log.debug('edge request', {
        query: url.search || undefined,
        contentType: request.headers.get('content-type') || undefined,
        auth: maskToken(request.headers.get('authorization')) || undefined,
        body: reqBody || undefined,
      });

      // Continue down the chain (other edge functions / the origin function).
      const response = await context.next();

      // Read the response body. Skip buffering for streaming responses (SSE) and
      // anything large, so we don't block or hold big payloads in memory.
      const resContentType = response.headers.get('content-type') || '';
      const resLen = Number(response.headers.get('content-length') || '0');
      let resBody = '';
      if (resContentType.includes('text/event-stream')) {
        resBody = '<streamed: text/event-stream, body not buffered>';
      } else if (resLen > MAX_BUFFER) {
        resBody = `<skipped: ${resLen} bytes>`;
      } else if (isProxy) {
        resBody = '<omitted: proxied API response>';
      } else {
        try {
          const text = await response.clone().text();
          // /mcp responses carry tool result values — log shape only. Other
          // paths log the (truncated) body for auth-flow debugging.
          resBody = isMcp ? JSON.stringify(mcpBodySummary(text)) : truncate(text);
        } catch (err) {
          resBody = `<unreadable response body: ${err instanceof Error ? err.message : String(err)}>`;
        }
      }

      log.debug('edge response', {
        status: response.status,
        contentType: resContentType || undefined,
        body: resBody || undefined,
      });

      return response;
    },
  );
};
