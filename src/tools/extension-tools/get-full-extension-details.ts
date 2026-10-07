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
  description:
    "Get the full detail for one Netlify extension in a team: what it does, its configuration, and whether it is currently installed. Use it before installing to check what an extension requires.",
  inputSchema: getFullExtensionDetailsParamsSchema,
  toolAnnotations: {
    readOnlyHint: true,
  },
  cb: async ({ extensionSlug, teamId }, {request}) => {
    return JSON.stringify(await getExtension({ extensionSlug, accountId: teamId, request }));
  }
}
