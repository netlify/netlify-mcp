// Registration client_name is client-asserted and unbounded, so both outputs
// are character-restricted and capped before they reach a URL.

// Keys: client_name lower-cased with everything but a-z removed.
// Values: the canonical agent names the CLI uses.
const AGENT_BY_NORMALIZED_NAME: Record<string, string> = {
  claude: 'claudeai', claudeai: 'claudeai', claudedesktop: 'claudeai',
  claudecode: 'claude',
  cursor: 'cursor',
  chatgpt: 'chatgpt', openai: 'chatgpt',
  windsurf: 'windsurf', codeium: 'windsurf',
  visualstudiocode: 'copilot', vscode: 'copilot', githubcopilot: 'copilot',
  geminicli: 'gemini',
  codex: 'codex',
};
const UNKNOWN_AGENT = 'other';
const MAX_UTM_TERM_NAME_LENGTH = 64;

/** Exact match on the normalized name; anything else is 'other'. */
export function canonicalAgent(clientName: string): string {
  const normalized = clientName.toLowerCase().replace(/[^a-z]/g, '');
  return AGENT_BY_NORMALIZED_NAME[normalized] ?? UNKNOWN_AGENT;
}

/** Keep only [A-Za-z0-9_.:-], then cap at 64 characters. */
export function cleanClientName(clientName: string): string {
  return clientName.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, MAX_UTM_TERM_NAME_LENGTH);
}

/**
 * '' when there is no name; otherwise the two extra query parameters, with a
 * leading '&', ready to concatenate onto the authorize URL. Built by plain
 * string concatenation, not a URL-encoding helper: the cleaned charset needs
 * no encoding, and the ':' in client_name:<raw> must stay literal.
 */
export function attributionParams(clientName: string | undefined): string {
  if (!clientName) {
    return '';
  }
  return `&utm_content=${canonicalAgent(clientName)}&utm_term=client_name:${cleanClientName(clientName)}`;
}
