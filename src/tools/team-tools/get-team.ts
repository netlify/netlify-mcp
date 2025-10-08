
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';
import { getEnrichedTeamModelForLLM } from './team-utils.js';

const getTeamParamsSchema = z.object({
  teamId: z.string()
});

export const getTeamDomainTool: DomainTool<typeof getTeamParamsSchema> = {
  domain: 'team',
  operation: 'get-team',
  inputSchema: getTeamParamsSchema,
  toolAnnotations: {  
    readOnlyHint: true,
  },
  cb: async ({ teamId }, {request}) => {
    return JSON.stringify(getEnrichedTeamModelForLLM(await getAPIJSONResult(`/api/v1/accounts/${teamId}`, {}, {}, request)));
  }
}
