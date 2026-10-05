import type { ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';

export interface DomainTool<T extends z.ZodType> {
  domain: ToolDomain;
  operation: string;
  inputSchema: T;
  /**
   * Overrides the generated `netlify-<domain>-<operation>` name on the granular
   * surface. Use it when the generated name reads badly or misdescribes the
   * behaviour — `netlify-deploy-deploy-site` stutters, and
   * `netlify-extension-initialize-database` names something the tool does not
   * do. The `operation` id is deliberately NOT renamed with it: that value is
   * part of the grouped selector's schema, so changing it would break callers
   * already using the grouped surface.
   */
  granularToolName?: string;
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
