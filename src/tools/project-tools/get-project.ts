
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';
import { getEnrichedSiteModelForLLM } from './project-utils.js';

const getProjectParamsSchema = z.object({
  siteId: z.string()
});

export const getProjectDomainTool: DomainTool<typeof getProjectParamsSchema> = {
  domain: 'project',
  operation: 'get-project',
  inputSchema: getProjectParamsSchema,
  cb: async ({ siteId }) => {
    return JSON.stringify(getEnrichedSiteModelForLLM(await getAPIJSONResult(`/api/v1/sites/${siteId}`)));
  }
}
