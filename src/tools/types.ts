import { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export interface DomainTool<T extends z.ZodType> {
  domain: ToolDomain;
  operation: string;
  inputSchema: T;
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
