const AGENT_NAME_DISALLOWED = /[^A-Za-z0-9_.-]/g;
const MAX_AGENT_NAME_LENGTH = 64;

let clientNameSource: () => string | undefined = () => undefined;

export const setMcpClientNameSource = (source: () => string | undefined): void => {
  clientNameSource = source;
};

export const sanitizeAgentName = (raw: string): string =>
  raw.replace(AGENT_NAME_DISALLOWED, '').slice(0, MAX_AGENT_NAME_LENGTH);

export const loginSpawnEnv = (base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const agent = sanitizeAgentName(clientNameSource() ?? '');
  return {
    ...base,
    NETLIFY_LOGIN_SOURCE: 'mcp',
    ...(agent ? { NETLIFY_AGENT: agent } : {}),
  };
};
