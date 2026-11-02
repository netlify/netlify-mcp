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
  // Defaults to replacing the whole match with `[REDACTED_<label>]`.
  replace?: (match: string, ...groups: string[]) => string;
}

const placeholder = (label: string) => `[REDACTED_${label}]`;

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
    pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_m, scheme) => `${scheme} ${placeholder('TOKEN')}`,
  },
  // Credentials embedded in a URL or connection string: scheme://user:pass@host
  {
    label: 'CREDENTIALS',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    replace: (_m, scheme) => `${scheme}${placeholder('CREDENTIALS')}@`,
  },
  // key=value / key: value pairs whose key names a secret. The lookahead skips
  // values already handled above, including `Authorization: Bearer [REDACTED_TOKEN]`,
  // so the scheme word is kept rather than redacted a second time.
  {
    label: 'SECRET',
    pattern: /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|cookie|credential|session[_-]?id)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)(?!\[REDACTED_|(?:Bearer|Basic|Token)\s)([^\s"',;&]{4,})/gi,
    replace: (_m, key, sep) => `${key}${sep}${placeholder('SECRET')}`,
  },
  { label: 'EMAIL', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

// Long mixed-case alphanumeric runs (40+ chars with upper, lower and digits)
// are almost always keys or encoded secrets. Ids that Netlify uses (24-hex
// deploy ids, UUIDs, 40-hex commit SHAs) are single-case, so they survive.
const HIGH_ENTROPY = /[A-Za-z0-9+/_=-]{40,}/g;
const looksRandom = (value: string) =>
  /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value) && !value.includes('/');

// Control characters (other than tab/newline) have no place in a report and
// can corrupt log lines.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export interface RedactionResult {
  text: string;
  redactions: number;
}

export const redactSensitive = (input: string): RedactionResult => {
  let redactions = 0;
  let text = input.replace(CONTROL_CHARS, '');

  for (const rule of RULES) {
    text = text.replace(rule.pattern, (match: string, ...rest: any[]) => {
      redactions++;
      // `rest` is the capture groups followed by offset and input string.
      const groups = rest.slice(0, -2) as string[];
      return rule.replace ? rule.replace(match, ...groups) : placeholder(rule.label);
    });
  }

  text = text.replace(HIGH_ENTROPY, (match) => {
    if (match.startsWith('[REDACTED_') || !looksRandom(match)) return match;
    redactions++;
    return placeholder('SECRET');
  });

  return { text, redactions };
};
