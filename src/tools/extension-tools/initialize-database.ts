
import { z } from 'zod';
import type { DomainTool } from '../types.js';

const initializeDatabaseParamsSchema = z.object({});

export const initializeDatabaseDomainTool: DomainTool<typeof initializeDatabaseParamsSchema> = {
  domain: 'extension',
  operation: 'initialize-database',
  description:
    "Return the steps for adding a Netlify Database (Postgres) to the current project. This only returns instructions — it does not provision anything or change the project.",
  inputSchema: initializeDatabaseParamsSchema,
  toolAnnotations: {
    readOnlyHint: false,
    // Returns setup instructions only; touches nothing.
    destructiveHint: false,
    idempotentHint: true,
},
  cb: async () => {
    return 'Ensure the @netlify/database npm package is installed. After installation, restart the development server or run a new build.';
  }
}
