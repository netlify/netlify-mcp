import { z } from 'zod';
import type { DomainTool } from '../types.js';
import { getExtension } from './extension-utils.js';

const getFullExtensionDetailsParamsSchema = z.object({
  extensionSlug: z.string(),
  teamId: z.string().describe('Team id of the current project team. If unsure, ask what Netlify team'),
});

export const getFullExtensionDetailsDomainTool: DomainTool<typeof getFullExtensionDetailsParamsSchema> = {
  domain: 'extension',
  operation: 'get-full-extension-details',
  inputSchema: getFullExtensionDetailsParamsSchema,
  cb: async ({ extensionSlug, teamId }, {request}) => {
    return JSON.stringify(await getExtension({ extensionSlug, accountId: teamId, request }));
  }
}
