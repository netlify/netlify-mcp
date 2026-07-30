// Request-scoped signals: a deterministic side channel from deep tool/API code
// back up to the HTTP handler, read AFTER the MCP SDK has produced its response.
//
// The motivating case is auth: when a downstream Netlify API call returns 401,
// the MCP SDK has already swallowed the thrown error into a normal 200 tool
// result (content + isError), so the transport layer can no longer see that the
// failure was an auth failure. Rather than sniff the response body for an error
// string — fragile, and silently broken if the SDK ever stops echoing messages —
// tool code flags the challenge here and the handler checks the flag to emit a
// proper 401 OAuth challenge.
//
// Like the logger's context, this rides AsyncLocalStorage so the flag set inside
// a tool callback (invoked by the SDK during handler.fetch) is visible to the
// handler afterward, without threading an object through every call. A runtime
// without AsyncLocalStorage falls back to a single slot (serverless/edge handle
// one request per isolate at a time, so this is safe).

import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestSignals {
  // Set when an authenticated Netlify API call returned 401 for this request.
  authChallenge?: { errorDescription?: string };
}

let store: AsyncLocalStorage<RequestSignals> | null = null;
try {
  store = new AsyncLocalStorage<RequestSignals>();
} catch {
  store = null;
}

// Used only when AsyncLocalStorage is unavailable.
let fallback: RequestSignals | null = null;

/**
 * Establish a fresh request-signals scope for everything run within `fn`
 * (including across awaits and inside SDK-invoked tool callbacks).
 */
export function withRequestSignals<T>(fn: () => T): T {
  const signals: RequestSignals = {};
  if (store) {
    return store.run(signals, fn);
  }
  const previous = fallback;
  fallback = signals;
  try {
    return fn();
  } finally {
    fallback = previous;
  }
}

function current(): RequestSignals | null {
  if (store) {
    return store.getStore() ?? null;
  }
  return fallback;
}

/**
 * Record that this request hit a Netlify auth failure (401) and must answer with
 * an OAuth challenge. Safe no-op outside a withRequestSignals scope (e.g. the CLI
 * stdio path), so tool code can call it unconditionally.
 */
export function flagAuthChallenge(errorDescription?: string): void {
  const signals = current();
  if (signals) {
    signals.authChallenge = { errorDescription };
  }
}

/**
 * Read the auth-challenge signal for the current request, or undefined if none
 * was flagged. Called by the HTTP handler after the SDK has produced its response.
 */
export function getAuthChallenge(): { errorDescription?: string } | undefined {
  return current()?.authChallenge;
}
