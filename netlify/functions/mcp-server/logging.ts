// Verbose transaction logging.
//
// Off by default. Set MCP_VERBOSE_LOGGING=true (or 1/yes) to log full
// per-transaction detail across the MCP, OAuth, and proxy functions. This is a
// diagnostic switch — leave it off in steady state. Errors are always logged
// regardless of this flag; log.debug()/verbose detail is the only thing it gates.
//
// Even in verbose mode, secrets are masked: bodies go through safeBodySummary()
// and tokens through maskToken(). We never log raw client secrets or full tokens.

export function isVerboseLogging(): boolean {
  try {
    // Tolerate stray whitespace and accidental surrounding quotes, e.g. '"true"'.
    const v = (process.env.MCP_VERBOSE_LOGGING ?? '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  } catch {
    // process may be unavailable in some runtimes (e.g. edge); default to off.
    return false;
  }
}

// Mask a token/credential for logging: keep enough to correlate, never the whole
// value. Returns e.g. "eyJhbGci…b2c4 (len 312)".
export function maskToken(value: string | null | undefined): string {
  if (!value) return '';
  const trimmed = value.replace(/^Bearer\s+/i, '');
  if (trimmed.length <= 12) return `*** (len ${trimmed.length})`;
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)} (len ${trimmed.length})`;
}

// Body fields that must never be logged in full. Everything else in a request
// body is considered safe to surface for debugging.
const SENSITIVE_BODY_FIELDS = new Set([
  'client_secret',
  'password',
  'code',
  'code_verifier',
  'refresh_token',
  'access_token',
  'id_token',
  'client_assertion',
  'registration_access_token',
]);

// Form-encoded bodies are logged with their KEYS intact, and key-name redaction
// can't mask a secret that arrives as an unexpected field name (e.g. an attacker
// posting `SECRET-AUTH-CODE=x`). So form parsing is restricted to these known
// OAuth parameters; a body with any other key falls through to `unparseable`
// rather than logging arbitrary field names. Sensitive values among these are
// still redacted by redactSensitive via SENSITIVE_BODY_FIELDS.
const SAFE_FORM_BODY_FIELDS = new Set([
  ...SENSITIVE_BODY_FIELDS,
  'grant_type',
  'scope',
  'client_id',
  'redirect_uri',
  'response_type',
  'response_mode',
  'state',
  'nonce',
  'code_challenge',
  'code_challenge_method',
  'client_assertion_type',
  'token_type_hint',
  'resource',
  'audience',
]);

// Deep-redacts sensitive fields anywhere in a parsed JSON value. Depth matters:
// MCP tool-call bodies nest secrets (params.arguments.password), so a top-level
// sweep misses them. `code` is redacted only when it's a string — the string form
// is an OAuth authorization code, while the numeric form is a JSON-RPC error code
// that logs need to keep.
//
// The depth cap is load-bearing: this runs on attacker-controlled bodies in the
// request path, and JSON.parse happily produces values deep enough to blow the
// recursion stack. No legitimate MCP payload comes anywhere near the cap.
const MAX_REDACT_DEPTH = 32;

export function redactSensitive<T>(value: T, depth = 0): T {
  if (depth >= MAX_REDACT_DEPTH) {
    return '[redacted: nesting too deep]' as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitive(entry, depth + 1)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) =>
        SENSITIVE_BODY_FIELDS.has(key) && (key !== 'code' || typeof entry === 'string')
          ? [key, '[redacted]']
          : [key, redactSensitive(entry, depth + 1)],
      ),
    ) as T;
  }
  return value;
}

// Produce a log-safe view of a request body: parses JSON or form-encoded
// payloads, redacts secrets at any depth, and surfaces the rest (including
// `scope`) so we can debug failures without leaking credentials.
export function safeBodySummary(body: string | null | undefined): Record<string, unknown> {
  if (!body) return { empty: true };

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON — accept the URLSearchParams fallback only when every key is a
    // recognized OAuth form field. Anything else (truncated JSON, plain text, or
    // an unexpected field name carrying a secret) would land verbatim in the
    // parsed object's KEYS, where key-name redaction can't catch it, so it must
    // fall through to `unparseable`.
    const form = Object.fromEntries(new URLSearchParams(body));
    const keys = Object.keys(form);
    parsed = keys.length > 0 && keys.every((key) => SAFE_FORM_BODY_FIELDS.has(key)) ? form : null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return { unparseable: true, length: body.length };
  }

  return redactSensitive(parsed as Record<string, unknown>);
}

// A value-free summary of JSON-RPC params: the tool name and the NAMES of the
// arguments sent (for tools/call), or the top-level param names for other
// methods — but never any values. Tool arguments carry secrets/PII (env var
// values, form submissions), so only their shape is ever logged.
export function paramsSummary(params: any): Record<string, unknown> {
  if (!params || typeof params !== 'object') {
    return {};
  }
  const summary: Record<string, unknown> = {};
  if (typeof params.name === 'string') {
    summary.toolName = params.name;
  }
  if (params.arguments && typeof params.arguments === 'object') {
    summary.argKeys = Object.keys(params.arguments);
  } else {
    summary.paramKeys = Object.keys(params);
  }
  return summary;
}

// A value-free summary of a raw MCP JSON-RPC body (request OR response) for the
// edge logger. Surfaces only shape — method/id, the tool name and argument
// names on a request, and whether a response carried a result/error — never any
// argument or result VALUES.
export function mcpBodySummary(body: string | null | undefined): Record<string, unknown> {
  if (!body) return { empty: true };

  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { unparseable: true, length: body.length };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { unparseable: true, length: body.length };
  }

  return {
    ...(parsed.method !== undefined ? { method: parsed.method } : {}),
    ...(parsed.id !== undefined ? { id: parsed.id } : {}),
    ...paramsSummary(parsed.params),
    ...(parsed.result !== undefined ? { hasResult: true } : {}),
    ...(parsed.error !== undefined ? { hasError: true } : {}),
  };
}
