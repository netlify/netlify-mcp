
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';
import { getEnrichedSiteModelForLLM } from './project-utils.js';

// historically, everything has been "site" but we are moving to
// presenting these as projects. Ids and such will be mapped to sites
// on the PI level
const domain = 'project';

const getProjectParamsSchema = z.object({
  siteId: z.string()
});

export const getProjectDomainTool: DomainTool<typeof getProjectParamsSchema> = {
  domain,
  operation: 'get-project',
  inputSchema: getProjectParamsSchema,
  cb: async ({ siteId }) => {
    return JSON.stringify(getEnrichedSiteModelForLLM(await getAPIJSONResult(`/api/v1/sites/${siteId}`)));
  }
}
