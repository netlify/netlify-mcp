import { z } from 'zod';

export interface DomainTool<T extends z.ZodType> {
  domain: ToolDomain;
  operation: string;
  inputSchema: T;
  cb: (input: z.infer<T>, mcpContext: MCPEnvContext) => Promise<string>;
}

export interface MCPEnvContext {
  request?: Request;
}

export type ToolDomain = 'project' | 'team' | 'user' | 'deploy' | 'extension';
