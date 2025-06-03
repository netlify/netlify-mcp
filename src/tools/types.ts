import { z } from 'zod';

export interface DomainTool<T extends z.ZodType> {
  domain: ToolDomain;
  operation: string;
  inputSchema: T;
  cb: (input: z.infer<T>) => Promise<string>;
}

export type ToolDomain = 'project' | 'team' | 'user' | 'deploy';
