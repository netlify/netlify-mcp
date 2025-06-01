
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';
import { getEnrichedTeamModelForLLM } from './team-utils.js';

const domain = 'team';

const getTeamsParamsSchema = z.object({});

export const getTeamsDomainTool: DomainTool<typeof getTeamsParamsSchema> = {
  domain,
  operation: 'get-teams',
  inputSchema: getTeamsParamsSchema,
  cb: async () => {
    return JSON.stringify(getEnrichedTeamModelForLLM(await getAPIJSONResult('/api/v1/accounts')));
  }
}
