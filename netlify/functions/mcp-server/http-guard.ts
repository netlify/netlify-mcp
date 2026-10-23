// Attach a default 'error' listener to every outbound Node http/https request.
//
// Our top error is a detached `socket hang up` (ECONNRESET) on a legacy-`http`
// request (stack bottoms out at node:_http_client) made by a dependency that
// never handles the socket's 'error' event — so it surfaces as an uncaughtException
// the platform logs as an opaque "Invoke Error". A process-level uncaughtException
// handler can't reliably suppress that on Lambda (the runtime reports it itself),
// but handling the 'error' at the request means it never becomes uncaught in the
// first place. If the caller adds its own 'error' listener too, both fire (harmless).
//
// This self-installs on import and MUST be imported FIRST in a function entrypoint
// (before any dependency that makes http calls), so the patch is in place before
// anything captures a reference to http.request/get. Node-only — never edge/Deno.

import http from 'node:http';
import https from 'node:https';
import { log } from './logger.ts';
import { isTransientNetworkError } from './process-guards.ts';

function attachErrorListener(req: unknown): unknown {
  try {
    (req as { on?: (e: string, cb: (err: unknown) => void) => void })?.on?.('error', (err: unknown) => {
      // Transient resets (ECONNRESET / "socket hang up") are expected background
      // noise and swallowed silently; anything else is worth a warn.
      if (!isTransientNetworkError(err)) {
        const anyErr = err as { code?: unknown; message?: unknown } | null;
        log.warn('outbound http request error', { code: anyErr?.code, message: anyErr?.message });
      }
    });
  } catch {
    // Instrumentation must never break a request.
  }
  return req;
}

function install(): void {
  try {
    if (typeof process === 'undefined') return;
    for (const mod of [http, https]) {
      for (const method of ['request', 'get'] as const) {
        const original = (mod as Record<string, unknown>)[method];
        if (typeof original !== 'function') continue;
        (mod as Record<string, unknown>)[method] = function patched(this: unknown, ...args: unknown[]) {
          return attachErrorListener((original as (...a: unknown[]) => unknown).apply(this, args));
        };
      }
    }
  } catch {
    // Best-effort; a failure here must not break function startup.
  }
}

install();
