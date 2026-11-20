// Best-effort scrubbing of sensitive values from free-text feedback.
//
// The tool description tells agents never to include secrets or personal data,
// but agents paste error output and config snippets, so this is the backstop:
// anything shaped like a credential or an email address is replaced before the
// text is stored or logged. It errs toward over-redacting — a feedback report
// loses nothing useful when a token-looking string becomes a placeholder.

interface RedactionRule {
  label: string;
  pattern: RegExp;
  // Defaults to replacing the whole match with `[REDACTED_<label>]`. Returning
  // null keeps the match as it is and does not count it as a redaction.
  replace?: (match: string, ...groups: string[]) => string | null;
}

const placeholder = (label: string) => `[REDACTED_${label}]`;

// Ordinary words that follow a scheme word in prose ("Token authentication",
// "Bearer token-based auth") and must not be read as credentials.
const PROSE_AFTER_SCHEME = new Set(['authentication', 'token-based']);

// Sentence punctuation that can end a value without being part of it. `=` is
// not included: it is base64 padding at the end of Basic credentials.
const TRAILING_PUNCTUATION = /[.~_-]+$/;

// Whether a value after `Bearer`/`Basic`/`Token` is a credential rather than an
// ordinary word, as in "Token validation failed". Real ones contain a digit or
// symbol, or mix upper and lower case (base64 Basic credentials). Trailing
// punctuation is ignored, so the period ending a sentence does not count.
const looksLikeCredential = (value: string) => {
  const core = value.replace(TRAILING_PUNCTUATION, '');
  if (PROSE_AFTER_SCHEME.has(core.toLowerCase())) return false;
  return /[0-9._~+/=-]/.test(core) || (/[a-z]/.test(core) && /[A-Z]/.test(core));
};

// Order matters: the specific shapes run before the generic catch-alls, so a
// key is labelled by what it is rather than as an anonymous long string.
const RULES: RedactionRule[] = [
  {
    label: 'PRIVATE_KEY',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  // JWTs and JWEs (the MCP's own access tokens are JWEs).
  { label: 'TOKEN', pattern: /\beyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*){1,4}/g },
  // Netlify personal, OAuth and other tokens.
  { label: 'TOKEN', pattern: /\bnf[a-z]_[A-Za-z0-9_-]{16,}/g },
  // GitHub, Slack, Stripe, OpenAI/Anthropic-style, Google and AWS keys.
  { label: 'TOKEN', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { label: 'TOKEN', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { label: 'TOKEN', pattern: /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { label: 'TOKEN', pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { label: 'TOKEN', pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { label: 'TOKEN', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // `Authorization: Bearer …` / `Basic …` headers.
  {
    label: 'TOKEN',
    pattern: /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
    replace: (_m, scheme, value) => {
      if (!looksLikeCredential(value)) return null;
      // Keep a sentence-ending period outside the placeholder.
      const trailing = value.endsWith('.') ? value.match(/\.+$/)![0] : '';
      return `${scheme} ${placeholder('TOKEN')}${trailing}`;
    },
  },
  // Credentials embedded in a URL or connection string: scheme://user:pass@host
  {
    label: 'CREDENTIALS',
    // `?` and `#` start a query or fragment, so an `@` after them is not part
    // of a user:password pair. Percent-encoded characters are still matched.
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@?#]+:[^\s/@?#]+@/gi,
    replace: (_m, scheme) => `${scheme}${placeholder('CREDENTIALS')}@`,
  },
  // A Cookie header carries several name=value pairs; redact all of them, up
  // to the end of the line, whether written `Cookie: …` or `cookie=…`.
  {
    label: 'SECRET',
    pattern: /\b((?:Set-)?Cookie)(\s*[:=]\s*)(?!["']|\[REDACTED_)[^\r\n]+/gi,
    replace: (_m, name, sep) => `${name}${sep}${placeholder('SECRET')}`,
  },
  // key=value / key: value pairs whose key names a secret. A quoted value is
  // redacted up to its closing quote, so multi-word passphrases are covered.
  // A `Bearer`/`Basic`/`Token` scheme word is kept and the credential after it
  // redacted, however short. Only values already redacted above are skipped,
  // such as `Authorization: Bearer [REDACTED_TOKEN]`.
  {
    label: 'SECRET',
    pattern: /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|cookie|credential|session[_-]?id)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(?!["']?\[REDACTED_)((?:Bearer|Basic|Token)\s+)?(?!\[REDACTED_|(?:Bearer|Basic|Token)\s)("[^"\r\n]+"|'[^'\r\n]+'|[^\s"',;&]+)/gi,
    replace: (_m, key, sep, scheme, value) => {
      // Without a scheme, very short values (`pwd: no`) are words, not secrets.
      if (!scheme && value.length < 4) return null;
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
      return `${key}${sep}${scheme ?? ''}${quote}${placeholder('SECRET')}${quote}`;
    },
  },
  { label: 'EMAIL', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

// Long mixed-case alphanumeric runs (40+ chars with upper, lower and digits)
// are almost always keys or encoded secrets. Ids that Netlify uses (24-hex
// deploy ids, UUIDs, 40-hex commit SHAs) are single-case, so they survive.
// Base64 secrets such as AWS secret access keys can contain `/`, which also
// appears in ordinary file paths. Paths are mostly lowercase, so a value with
// a `/` must also be at least a quarter uppercase letters to count.
const HIGH_ENTROPY = /[A-Za-z0-9+/_=-]{40,}/g;
const looksRandom = (value: string) => {
  if (!(/[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value))) return false;
  if (!value.includes('/')) return true;
  const letters = value.replace(/[^A-Za-z]/g, '');
  const upper = value.replace(/[^A-Z]/g, '');
  return upper.length / letters.length >= 0.25;
};

// Control characters (other than tab/newline) have no place in a report and
// can corrupt log lines.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export interface RedactionResult {
  text: string;
  redactions: number;
}

// Distinct from `redactSensitive` in the server's logging module, which hides
// values by field name; this one scans free text.
export const scrubFeedbackText = (input: string): RedactionResult => {
  let redactions = 0;
  let text = input.replace(CONTROL_CHARS, '');

  for (const rule of RULES) {
    text = text.replace(rule.pattern, (match: string, ...rest: any[]) => {
      // `rest` is the capture groups followed by offset and input string.
      const groups = rest.slice(0, -2) as string[];
      const replacement = rule.replace ? rule.replace(match, ...groups) : placeholder(rule.label);
      if (replacement === null) return match;
      redactions++;
      return replacement;
    });
  }

  text = text.replace(HIGH_ENTROPY, (match) => {
    if (match.startsWith('[REDACTED_') || !looksRandom(match)) return match;
    redactions++;
    return placeholder('SECRET');
  });

  return { text, redactions };
};
