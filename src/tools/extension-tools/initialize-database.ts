
import { z } from 'zod';
import type { DomainTool } from '../types.js';

const initializeDatabaseParamsSchema = z.object({});

export const initializeDatabaseDomainTool: DomainTool<typeof initializeDatabaseParamsSchema> = {
  domain: 'extension',
  operation: 'initialize-database',
  inputSchema: initializeDatabaseParamsSchema,
  cb: async () => {
    return 'Ensure the @netlify/neon npm package is installed. After installation, restart the development server or run new build.';
  }
}
