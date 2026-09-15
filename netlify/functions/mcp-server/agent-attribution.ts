// Registration client_name is client-asserted and unbounded, so both outputs
// are character-restricted and capped before they reach a URL.

// Mirrors CANONICAL_AGENT_NAMES in the CLI (netlify/cli, src/utils/agent-detection.ts).
// Local and remote signups must emit the same vocabulary; change both together.
const CANONICAL_AGENT_NAMES = [
  'claude', 'codex', 'copilot', 'gemini', 'cursor', 'opencode', 'kiro',
  'cline', 'amp', 'warp', 'claudeai', 'chatgpt', 'other',
] as const;
type CanonicalAgentName = (typeof CANONICAL_AGENT_NAMES)[number];

// Keys: client_name lower-cased with everything but a-z removed.
const AGENT_BY_NORMALIZED_NAME: Record<string, CanonicalAgentName> = {
  claude: 'claudeai', claudeai: 'claudeai', claudedesktop: 'claudeai',
  claudecode: 'claude',
  cursor: 'cursor',
  chatgpt: 'chatgpt', openai: 'chatgpt',
  copilot: 'copilot', visualstudiocode: 'copilot', vscode: 'copilot', githubcopilot: 'copilot',
  gemini: 'gemini', geminicli: 'gemini',
  codex: 'codex',
  opencode: 'opencode',
  kiro: 'kiro', kirocli: 'kiro',
  cline: 'cline',
  amp: 'amp',
  warp: 'warp', warpoz: 'warp',
};
const UNKNOWN_AGENT: CanonicalAgentName = 'other';
const MAX_UTM_TERM_LENGTH = 64;

/** Exact match on the normalized name; anything else is 'other'. */
export function canonicalAgent(clientName: string): CanonicalAgentName {
  const normalized = clientName.toLowerCase().replace(/[^a-z]/g, '');
  return Object.hasOwn(AGENT_BY_NORMALIZED_NAME, normalized)
    ? AGENT_BY_NORMALIZED_NAME[normalized]
    : UNKNOWN_AGENT;
}

/** Keep only [A-Za-z0-9_.:-]. No cap here; the whole utm_term is capped. */
export function cleanClientName(clientName: string): string {
  return clientName.replace(/[^A-Za-z0-9_.:-]/g, '');
}

/**
 * '' when there is no name; otherwise the two extra query parameters, with a
 * leading '&', ready to concatenate onto the authorize URL. The utm_term value
 * (`client_name:<cleaned>`) is capped at 64 as a whole. Built by plain string
 * concatenation, not a URL-encoding helper: the cleaned charset needs no
 * encoding, and the ':' in client_name:<raw> must stay literal.
 */
export function attributionParams(clientName: string | undefined): string {
  if (!clientName) {
    return '';
  }
  const utmTerm = `client_name:${cleanClientName(clientName)}`.slice(0, MAX_UTM_TERM_LENGTH);
  return `&utm_content=${canonicalAgent(clientName)}&utm_term=${utmTerm}`;
}
