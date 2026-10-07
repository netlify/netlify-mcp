
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { NetlifyAccountResponse } from '../../utils/api-types.js';
import type { DomainTool } from '../types.js';
import { getEnrichedTeamModelForLLM } from './team-utils.js';

const getTeamParamsSchema = z.object({
  teamId: z.string()
});

export const getTeamDomainTool: DomainTool<typeof getTeamParamsSchema> = {
  domain: 'team',
  operation: 'get-team',
  description:
    "Get one Netlify team by id, including its name, slug, and plan. Use it to confirm which team you are about to act on.",
  inputSchema: getTeamParamsSchema,
  toolAnnotations: {  
    readOnlyHint: true,
  },
  cb: async ({ teamId }, {request}) => {
    return JSON.stringify(getEnrichedTeamModelForLLM(await getAPIJSONResult<NetlifyAccountResponse>(`/api/v1/accounts/${teamId}`, {}, {}, request)));
  }
}
