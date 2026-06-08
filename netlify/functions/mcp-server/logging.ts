// Verbose transaction logging.
//
// Off by default. Set MCP_VERBOSE_LOGGING=true (or 1/yes) to log full
// per-transaction detail across the MCP, OAuth, and proxy functions. This is a
// diagnostic switch — leave it off in steady state. Errors are always logged
// regardless of this flag; debugLog()/verbose detail is the only thing it gates.
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

// Logs only when verbose logging is enabled. Use for per-transaction detail that
// would otherwise be noise in steady state.
export function debugLog(label: string, details?: unknown): void {
  if (!isVerboseLogging()) return;
  if (details === undefined) {
    console.log(`[verbose] ${label}`);
  } else {
    console.log(`[verbose] ${label}`, details);
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

// Produce a log-safe view of a request body: parses JSON or form-encoded
// payloads, redacts secrets, and surfaces the rest (including `scope`) so we can
// debug failures without leaking credentials.
export function safeBodySummary(body: string | null | undefined): Record<string, unknown> {
  if (!body) return { empty: true };

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // not JSON — fall back to form-encoded (URLSearchParams never throws)
    parsed = Object.fromEntries(new URLSearchParams(body));
  }

  if (!parsed || typeof parsed !== 'object') {
    return { unparseable: true, length: body.length };
  }

  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    safe[key] = SENSITIVE_BODY_FIELDS.has(key) ? '[redacted]' : value;
  }
  return safe;
}
