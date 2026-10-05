
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { NetlifyDeployResponse } from '../../utils/api-types.js';
import type { DomainTool } from '../types.js';

const getDeployBySiteIdParamsSchema = z.object({
  siteId: z.string(),
  deployId: z.string() // todo: make optional and get last deploy for site when missing
});

export const getDeployBySiteIdDomainTool: DomainTool<typeof getDeployBySiteIdParamsSchema> = {
  domain: 'deploy',
  operation: 'get-deploy-for-site',
  description:
    "Get a deploy belonging to a specific Netlify site, given both the site id and deploy id. Returns the same detail as get-deploy but scoped to the site, so it will not return a deploy from another site.",
  inputSchema: getDeployBySiteIdParamsSchema,
  toolAnnotations: {
    readOnlyHint: true,
  },
  cb: async (params, {request}) => {
    const { siteId, deployId } = params;
    return JSON.stringify(await getAPIJSONResult<NetlifyDeployResponse>(`/api/v1/sites/${siteId}/deploys/${deployId}`, {}, {}, request));
  }
}
