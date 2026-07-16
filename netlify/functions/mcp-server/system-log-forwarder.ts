// Node-only log forwarder that routes records onto Netlify's system-log channel.
//
// Netlify's function runtime tags any stdout line beginning with `__nfSystemLog`
// as a system log (internal_log_type=system), routing it to the internal
// system-log channel separate from user-facing function output. We emit our full
// FLAT record as the payload — rather than @netlify/functions/internal's nested
// `{msg, fields}` shape — so the line is a single JSON.parse away from every
// field (service, requestId, userId, …) instead of two levels deep.
//
// IMPORTANT: only import this from Node serverless function entry points
// (mcp.ts, oauth-server.ts). It must never reach the Deno edge functions or the
// stdio CLI (whose stdout is the MCP protocol channel).

import { safeStringify, type LogForwarder } from './logger.ts';

// Netlify's system-log marker. A stdout line beginning with this token is
// promoted to internal_log_type=system by the function runtime. (Same tag
// @netlify/functions/internal uses; hardcoded here so we control the payload
// shape and avoid depending on that internal package.)
const SYSTEM_LOG_TAG = '__nfSystemLog';

export const systemLogForwarder: LogForwarder = (level, record) => {
  const line = `${SYSTEM_LOG_TAG} ${safeStringify(record)}`;
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
};
