
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';
import { getEnrichedTeamModelForLLM } from './team-utils.js';

const domain = 'team';

const getTeamParamsSchema = z.object({
  teamId: z.string()
});

export const getTeamDomainTool: DomainTool<typeof getTeamParamsSchema> = {
  domain,
  operation: 'get-team',
  inputSchema: getTeamParamsSchema,
  cb: async ({ teamId }) => {
    return JSON.stringify(getEnrichedTeamModelForLLM(await getAPIJSONResult(`/api/v1/accounts/${teamId}`)));
  }
}
