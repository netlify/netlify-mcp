
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';
import { getEnrichedTeamModelForLLM } from './team-utils.js';

const getTeamsParamsSchema = z.object({});

export const getTeamsDomainTool: DomainTool<typeof getTeamsParamsSchema> = {
  domain: 'team',
  operation: 'get-teams',
  inputSchema: getTeamsParamsSchema,
  toolAnnotations: {
    readOnlyHint: true,
  },
  cb: async (_, {request}) => {
    return JSON.stringify(getEnrichedTeamModelForLLM(await getAPIJSONResult('/api/v1/accounts', {}, {}, request)));
  }
}
