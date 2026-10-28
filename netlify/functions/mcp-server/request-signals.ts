// Request-scoped signals: a deterministic side channel from deep tool/API code
// back up to the HTTP handler, read AFTER the MCP SDK has produced its response.
//
// The motivating case is auth: when a downstream Netlify API call returns 401,
// the MCP SDK has already swallowed the thrown error into a normal 200 tool
// result (content + isError), so the transport layer can no longer see that the
// call was rejected. Rather than sniff the response body for an error string —
// fragile, and silently broken if the SDK ever stops echoing messages — the
// fetch helper records the 401 here. A 401 doesn't always mean a bad token, so
// the handler confirms it before emitting an OAuth challenge.
//
// Like the logger's context, this rides AsyncLocalStorage so the flag set inside
// a tool callback (invoked by the SDK during handler.fetch) is visible to the
// handler afterward, without threading an object through every call. A runtime
// without AsyncLocalStorage falls back to a single slot (serverless/edge handle
// one request per isolate at a time, so this is safe).

import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestSignals {
  // Set when a Netlify API call returned 401 for this request (first one wins).
  netlify401?: { path: string };
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
 * Record that a Netlify API call returned 401, with its path. The first 401 in a
 * request wins. Not proof of a bad token; the handler confirms. Safe no-op
 * outside a withRequestSignals scope (e.g. the CLI stdio path), so callers can
 * call it unconditionally.
 */
export function flagNetlify401(path: string): void {
  const signals = current();
  if (signals && !signals.netlify401) {
    signals.netlify401 = { path };
  }
}

/**
 * Read the recorded 401 for the current request, or undefined if none. Called by
 * the HTTP handler after the SDK has produced its response.
 */
export function getNetlify401(): { path: string } | undefined {
  return current()?.netlify401;
}
