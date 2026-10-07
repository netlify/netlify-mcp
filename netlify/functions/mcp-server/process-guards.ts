// Resilience against detached, benign network transients.
//
// Our top error by volume is a `socket hang up` (ECONNRESET) surfaced as an
// "Invoke Error" / "Unhandled Promise Rejection" — a keep-alive socket some
// background HTTP call reused after the peer had already closed it. The stack is
// `node:_http_client` (the legacy http module), which none of our code uses, so
// it comes from a dependency's fire-and-forget request and isn't tied to any live
// request. On Lambda an unhandled one becomes an opaque invocation failure.
//
// A reset socket doesn't corrupt process state, so we take over the process-level
// handlers: log these transients and swallow them (the function keeps serving),
// while genuine errors are still logged and — for uncaught exceptions, which DO
// leave the process in an undefined state — re-raised so the sandbox recycles.

import { log } from './logger.ts';

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

export function isTransientNetworkError(err: unknown): boolean {
  const anyErr = err as { code?: unknown; cause?: { code?: unknown }; message?: unknown } | null;
  const code = anyErr?.code ?? anyErr?.cause?.code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) {
    return true;
  }
  const message = String(anyErr?.message ?? err ?? '');
  return /socket hang up/i.test(message);
}

function fields(err: unknown) {
  const anyErr = err as { code?: unknown; cause?: { code?: unknown }; message?: unknown } | null;
  return { code: anyErr?.code ?? anyErr?.cause?.code, message: anyErr?.message };
}

let installed = false;

export function installProcessGuards(): void {
  if (installed) return;
  installed = true;

  // Runs at cold-start module load and only touches process-level handlers, which
  // are a resilience optimization — not core behavior. So it's best-effort: don't
  // assume `process` exists (e.g. a non-Node runtime), and never let a failure
  // installing the handlers break function startup. Degrade to a no-op.
  try {
    if (typeof process === 'undefined' || typeof process.on !== 'function') {
      return;
    }

    // Own unhandledRejection so a detached transient (see above) doesn't fail the
    // invocation. Non-transient rejections are logged at error but not re-thrown —
    // an unhandled rejection doesn't corrupt process state, and crashing the whole
    // warm container for one stray promise is worse than logging and continuing.
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', (reason: unknown) => {
      try {
        if (isTransientNetworkError(reason)) {
          log.warn('transient network rejection swallowed', fields(reason));
          return;
        }
        log.error('unhandled rejection', { err: reason });
      } catch {
        // A rejection handler must never throw — that would become an uncaught
        // exception and defeat the purpose.
      }
    });

    // Own uncaughtException likewise, but re-raise non-transient ones: an uncaught
    // exception can leave the process in an undefined state, so let the platform
    // recycle the sandbox.
    process.removeAllListeners('uncaughtException');
    process.on('uncaughtException', (err: unknown) => {
      try {
        if (isTransientNetworkError(err)) {
          log.warn('transient network exception swallowed', fields(err));
          return;
        }
        log.error('uncaught exception', { err });
      } catch {
        // fall through to re-raise
      }
      throw err;
    });
  } catch {
    // Installing the guards is best-effort; a failure here must not break startup.
  }
}
