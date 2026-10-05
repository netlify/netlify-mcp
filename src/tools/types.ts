import type { ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';

export interface DomainTool<T extends z.ZodType> {
  domain: ToolDomain;
  operation: string;
  inputSchema: T;
  /**
   * What this operation does, when to reach for it, and anything it will
   * change. Required reading for the granular surface: when each operation is
   * registered as its own tool there is no domain-level description left to
   * carry the meaning, and OpenAI's guidelines reject a tool whose "behavior is
   * unclear or incomplete from its description". Falls back to a generated
   * stub when absent.
   */
  description?: string;
  toolAnnotations: ToolAnnotations;
  omitFromRemoteMCP?: boolean;
  omitFromLocalMCP?: boolean;
  cb: (input: z.infer<T>, mcpContext: MCPEnvContext) => Promise<string>;
}

export interface MCPEnvContext {
  request?: Request;
  isRemoteMCP?: boolean;
}

export type ToolDomain = 'project' | 'team' | 'user' | 'deploy' | 'extension';
