
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';

const getTeamEnvVarsParamsSchema = z.object({
  teamId: z.string(),
  envVarKey: z.string().optional(),
});

export const getTeamEnvVarsDomainTool: DomainTool<typeof getTeamEnvVarsParamsSchema> = {
  domain: 'team',
  operation: 'get-team-env-vars',
  inputSchema: getTeamEnvVarsParamsSchema,
  toolAnnotations: {
    readOnlyHint: true,
  },
  cb: async ({ teamId, envVarKey }, {request}) => {
    const envVars = await getAPIJSONResult(`/api/v1/accounts/${teamId}/env`, {}, {}, request);

    if (envVarKey) {
      return JSON.stringify(envVars.find((envVar: any) => envVar.key === envVarKey));
    }

    return JSON.stringify(envVars);
  }
}
