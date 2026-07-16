// Node-only log forwarder that routes records onto Netlify's system-log channel.
//
// Netlify's systemLogger tags lines with `__nfSystemLog` so the platform routes
// them onto its internal system-log channel (separate from user-facing function
// output). This forwarder maps each record we build onto systemLogger,
// preserving our full flat metadata under `fields`. Pass it to initLogger() from
// a Node entry point.
//
// IMPORTANT: only import this from Node serverless function entry points
// (mcp.ts, oauth-server.ts). The `@netlify/functions/internal` package imports
// `process` and is Node-only, so it must never reach the shared logger.ts (which
// the Deno edge functions bundle) or the stdio CLI (whose stdout is the MCP
// protocol channel).

import { systemLogger, LogLevel } from '@netlify/functions/internal';
import { jsonSafe, type LogForwarder } from './logger.ts';

export const systemLogForwarder: LogForwarder = (level, record) => {
  // `message` becomes systemLogger's `msg`; everything else (including our
  // timestamp/level/service) rides along as fields. jsonSafe guards against
  // circular/bigint values that systemLogger's own JSON.stringify would throw
  // on.
  const { message, ...rest } = record;
  const msg = typeof message === 'string' ? message : String(message ?? '');
  const fields = jsonSafe(rest) as Record<string, unknown>;

  // systemLogger has three levels (debug/log/error) and no `warn`, so warn folds
  // into `log` — the original severity is still the `level` field for filtering.
  // debug must raise the logger's own level or it self-suppresses (default Log).
  // Any throw here is caught by the logger's forwarder guard.
  if (level === 'error') {
    systemLogger.withFields(fields).error(msg);
  } else if (level === 'debug') {
    systemLogger.withLogLevel(LogLevel.Debug).withFields(fields).debug(msg);
  } else {
    systemLogger.withFields(fields).log(msg);
  }
};
