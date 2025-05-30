import { z } from 'zod';

export interface DomainTool<T extends z.ZodType> {
  domain: string;
  operation: string;
  inputSchema: T;
  cb: (input: z.infer<T>) => Promise<string>;
}
