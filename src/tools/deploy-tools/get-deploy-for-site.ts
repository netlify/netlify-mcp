
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';

const domain = 'deploy';

const getDeployBySiteIdParamsSchema = z.object({
  siteId: z.string(),
  deployId: z.string() // todo: make optional and get last deploy for site when missing
});

export const getDeployBySiteIdDomainTool: DomainTool<typeof getDeployBySiteIdParamsSchema> = {
  domain,
  operation: 'get-deploy-for-site',
  inputSchema: getDeployBySiteIdParamsSchema,
  cb: async (params) => {
    const { siteId, deployId } = params;
    return JSON.stringify(await getAPIJSONResult(`/api/v1/sites/${siteId}/deploys/${deployId}`));
  }
}
