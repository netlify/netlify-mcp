// Structured JSON logger with request-scoped metadata.
//
// Every log line is a single JSON object: the human-readable string lives in
// `message`, and all metadata (service, requestId, version, userId, teamId, and
// any per-call fields) sits flat alongside it. Steady-state severities
// (info/warn/error) always emit; `debug` is gated by MCP_VERBOSE_LOGGING.
//
// Metadata is established once at the edge of a request via withLogContext(),
// then rides every log() call made anywhere downstream — no need to thread a
// logger object through the call stack. Context propagates across awaits using
// AsyncLocalStorage; a runtime without it falls back to a single-slot store
// (serverless/edge handle one request per isolate at a time, so this is safe).

import { AsyncLocalStorage } from 'node:async_hooks';
import { isVerboseLogging } from './logging.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogContext = Record<string, unknown>;

// The logger owns these keys unconditionally; nothing in the context or a
// per-call `fields` object may overwrite them.
const RESERVED_KEYS = ['timestamp', 'level', 'message'] as const;

// AsyncLocalStorage is available in Node and in Netlify's Deno edge runtime
// (via node:async_hooks). Guard construction so a runtime that lacks it degrades
// to the single-slot fallback rather than throwing at module load.
let store: AsyncLocalStorage<LogContext> | null = null;
try {
  store = new AsyncLocalStorage<LogContext>();
} catch {
  store = null;
}

// Used only when AsyncLocalStorage is unavailable.
let fallbackContext: LogContext | null = null;

/**
 * Establish the base metadata for everything logged within `fn` (including
 * across awaits). The context object is mutable — see addLogContext — so fields
 * discovered mid-request (e.g. userId/teamId after auth) can be folded in and
 * will appear on every subsequent line.
 */
export function withLogContext<T>(base: LogContext, fn: () => T): T {
  const ctx: LogContext = { ...base };
  if (store) {
    return store.run(ctx, fn);
  }
  const previous = fallbackContext;
  fallbackContext = ctx;
  try {
    return fn();
  } finally {
    fallbackContext = previous;
  }
}

function currentContext(): LogContext | null {
  if (store) {
    return store.getStore() ?? null;
  }
  return fallbackContext;
}

/**
 * Merge fields into the current request's context in place, so they appear on
 * all later log lines for this request. No-op if called outside a
 * withLogContext scope.
 */
export function addLogContext(fields: LogContext): void {
  const ctx = currentContext();
  if (ctx) {
    Object.assign(ctx, fields);
  }
}

/** Generate a per-request correlation id. */
export function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Fallback for runtimes without global crypto — uniqueness within a short
    // window is enough for log correlation.
    return `req_${Date.now().toString(36)}`;
  }
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return err;
}

// JSON.stringify can throw on circular structures (e.g. an Error's cause chain
// or a request object accidentally passed as a field). Fall back to a
// circular-safe pass so a logging call can never crash the request.
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'bigint') return val.toString();
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '[circular]';
        seen.add(val);
      }
      return val;
    });
  }
}

/**
 * Return a JSON-safe deep clone of `value` (circular refs → '[circular]',
 * bigints → strings). Used by sinks that hand the record to another serializer
 * (e.g. systemLogger's own JSON.stringify) which would otherwise throw.
 */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(safeStringify(value));
}

// A forwarder receives every fully-built log record and ships it to an
// additional destination. It runs ON TOP OF the always-on console write, never
// instead of it — so structured logs are guaranteed even if the forwarder (or
// its dependency) is unavailable.
export type LogForwarder = (level: LogLevel, record: Record<string, unknown>) => void;

// Always-on: flat JSON to the matching console stream, for every log line
// regardless of whether a forwarder is configured.
function writeToConsole(level: LogLevel, record: Record<string, unknown>): void {
  const line = safeStringify(record);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// Optional additional destination. Node function entry points set this to the
// systemLogger forwarder (see system-log-forwarder.ts) so lines also land on
// Netlify's system-log channel; when unset (edge, CLI, or pre-init) only the
// console write happens. The systemLogger package is Node-only, which is why
// this is injected rather than baked in.
let forwarder: LogForwarder | null = null;

/**
 * Register an additional destination for every log record, on top of the
 * always-on console write. The runtime with an extra destination (Node
 * functions → systemLogger) calls this once at cold start.
 */
export function initLogger(options: { forward: LogForwarder }): void {
  forwarder = options.forward;
}

function emit(level: LogLevel, message: string, fields?: LogContext): void {
  // debug is diagnostic-only; skip the work entirely in steady state.
  if (level === 'debug' && !isVerboseLogging()) {
    return;
  }

  const ctx = { ...(currentContext() ?? {}) };
  const extra = { ...(fields ?? {}) };
  // Reserved keys are owned by the logger; strip any stray copies so they can't
  // shadow the authoritative values set below.
  for (const key of RESERVED_KEYS) {
    delete ctx[key];
    delete extra[key];
  }

  // Surface Errors as structured objects rather than `{}` under common keys.
  for (const key of ['err', 'error'] as const) {
    if (extra[key] instanceof Error) {
      extra[key] = serializeError(extra[key]);
    }
  }

  // Ordered for readability: timestamp, level, service, message come first, then
  // the remaining context (requestId, version, userId, …), then per-call fields
  // (which may add to or override non-reserved context).
  const { service, ...ctxRest } = ctx;
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    ...(service !== undefined ? { service } : {}),
    message,
    ...ctxRest,
    ...extra,
  };

  // Always write to the console first, so the structured line is guaranteed
  // even if a forwarder throws.
  writeToConsole(level, record);

  if (forwarder) {
    try {
      forwarder(level, record);
    } catch {
      // A forwarder failure must never break the request or lose the console
      // line we already wrote.
    }
  }
}

export const log = {
  debug: (message: string, fields?: LogContext) => emit('debug', message, fields),
  info: (message: string, fields?: LogContext) => emit('info', message, fields),
  warn: (message: string, fields?: LogContext) => emit('warn', message, fields),
  error: (message: string, fields?: LogContext) => emit('error', message, fields),
};
