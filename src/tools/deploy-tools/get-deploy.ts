import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { NetlifyDeployResponse } from '../../utils/api-types.js';
import type { DomainTool } from '../types.js';

const getDeployByIdParamsSchema = z.object({
  deployId: z.string()
});

export const getDeployByIdDomainTool: DomainTool<typeof getDeployByIdParamsSchema> = {
  domain: 'deploy',
  operation: 'get-deploy',
  description:
    "Get one Netlify deploy by its deploy id, including state (ready, building, error), the error message when it failed, branch, commit, duration, and its URLs. Use it to check whether a specific deploy succeeded or to read why it failed. Requires a deploy id: if you only know the site, read the site with get-project first, which reports its published deploy.",
  inputSchema: getDeployByIdParamsSchema,
  toolAnnotations: {
    readOnlyHint: true,
  },
  cb: async (params, {request}) => {
    const { deployId } = params;
    return JSON.stringify(await getAPIJSONResult<NetlifyDeployResponse>(`/api/v1/deploys/${deployId}`, {}, {}, request));
  }
}
