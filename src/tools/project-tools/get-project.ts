
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { NetlifySiteResponse } from '../../utils/api-types.js';
import type { DomainTool } from '../types.js';
import { getEnrichedSiteModelForLLM } from './project-utils.js';

const getProjectParamsSchema = z.object({
  siteId: z.string()
});

export const getProjectDomainTool: DomainTool<typeof getProjectParamsSchema> = {
  domain: 'project',
  operation: 'get-project',
  description:
    "Get one Netlify project (site) by id: its name, plan, team id, public and branch URLs, visitor access controls (password and SSO requirements), and the state and id of its currently published deploy. Does not return build settings or the detected framework.",
  inputSchema: getProjectParamsSchema,
  toolAnnotations: {
    readOnlyHint: true,
  },
  cb: async ({ siteId }, {request}) => {
    return JSON.stringify(getEnrichedSiteModelForLLM(await getAPIJSONResult<NetlifySiteResponse>(`/api/v1/sites/${siteId}`, {}, {}, request)));
  }
}
