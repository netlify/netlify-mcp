import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';

const getDeployByIdParamsSchema = z.object({
  deployId: z.string()
});

export const getDeployByIdDomainTool: DomainTool<typeof getDeployByIdParamsSchema> = {
  domain: 'deploy',
  operation: 'get-deploy',
  inputSchema: getDeployByIdParamsSchema,
  cb: async (params) => {
    const { deployId } = params;
    return JSON.stringify(await getAPIJSONResult(`/api/v1/deploys/${deployId}`));
  }
}
