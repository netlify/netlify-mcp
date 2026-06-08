import type { Context } from '@netlify/edge-functions';
import { isVerboseLogging, maskToken } from '../functions/mcp-server/logging.ts';

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
  const label = `${request.method} ${url.pathname}`;

  // Read the request body via a clone so the original is left intact for
  // downstream handlers (context.next()).
  let reqBody = '';
  try {
    if (request.body) {
      reqBody = truncate(await request.clone().text());
    }
  } catch (err) {
    reqBody = `<unreadable request body: ${err instanceof Error ? err.message : String(err)}>`;
  }

  console.log('[edge] →', {
    label,
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
  } else {
    try {
      resBody = truncate(await response.clone().text());
    } catch (err) {
      resBody = `<unreadable response body: ${err instanceof Error ? err.message : String(err)}>`;
    }
  }

  console.log('[edge] ←', {
    label,
    status: response.status,
    contentType: resContentType || undefined,
    body: resBody || undefined,
  });

  return response;
};
