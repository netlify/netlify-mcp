// Detects whether an MCP request comes from a Claude client that should see the
// Claude-Design import tool. Used to keep the tool out of every non-Claude agent's
// tools/list. The user-agent is checked on every request because the remote server
// is stateless: clientInfo only arrives on initialize, never on the tools/list or
// tools/call that follow.
//
// Claude Code is excluded: it is a coding CLI where an "import a design" tool is
// out of place, and it is the one Claude surface we can tell apart by user-agent
// (claude-code/<version>). claude.ai chat and Claude Design share the Claude-User
// agent, so they cannot be separated here — both still match.
const CLAUDE_CLIENT_PATTERN = /claude|anthropic/i;
const CLAUDE_CODE_PATTERN = /claude-code/i;

export function isClaudeMCPClient(req: Request, body: any): boolean {
  const userAgent = req.headers.get('user-agent') || '';
  const clientName = body?.params?.clientInfo?.name || '';
  if (CLAUDE_CODE_PATTERN.test(userAgent) || CLAUDE_CODE_PATTERN.test(clientName)) {
    return false;
  }
  return CLAUDE_CLIENT_PATTERN.test(userAgent) || CLAUDE_CLIENT_PATTERN.test(clientName);
}


// OpenAI's MCP client (ChatGPT / Codex) identifies itself with a user-agent
// beginning `openai-mcp`. It gets the GRANULAR tool surface: one tool per
// operation rather than a per-domain selector that dispatches through a union.
//
// This is required rather than cosmetic. OpenAI's app guidelines say to "expose
// each model-callable operation as a separate tool with a clear description,
// input schema, and annotations", and specifically not to "use discovery,
// operation selection, or schema fetching with a generic executor to enable
// operations not individually exposed for review" — which is exactly what the
// grouped `netlify-<domain>-services-<reader|updater>` tools do. Every grouped
// tool that fronts more than one operation came back from review as needing
// further review; the two that front a single operation did not.
//
// Matched on user-agent alone, not clientInfo: this server is stateless and
// clientInfo only arrives on `initialize`, never on the `tools/list` that
// actually needs the decision.
const OPENAI_MCP_USER_AGENT_PREFIX = 'openai-mcp';

export function isOpenAIMCPClient(req?: Request): boolean {
  const userAgent = req?.headers.get('user-agent') ?? '';
  return userAgent.trim().toLowerCase().startsWith(OPENAI_MCP_USER_AGENT_PREFIX);
}
