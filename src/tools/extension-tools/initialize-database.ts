
import { z } from 'zod';
import type { DomainTool } from '../types.js';

const initializeDatabaseParamsSchema = z.object({});

export const initializeDatabaseDomainTool: DomainTool<typeof initializeDatabaseParamsSchema> = {
  domain: 'extension',
  operation: 'initialize-database',
  granularToolName: 'netlify-get-database-setup-steps',
  description:
    "Get the setup steps for adding a Netlify Database (Postgres) to the current project. Returns written instructions only: it does not provision a database, install anything, or change the project. Follow the returned steps to actually add the database.",
  inputSchema: initializeDatabaseParamsSchema,
  toolAnnotations: {
    // Returns setup instructions as text. It calls nothing and changes
    // nothing, so it is a read, not a write — grouping it with the real
    // writers overstated it on the granular surface.
    readOnlyHint: true,
},
  cb: async () => {
    return 'Ensure the @netlify/database npm package is installed. After installation, restart the development server or run a new build.';
  }
}
