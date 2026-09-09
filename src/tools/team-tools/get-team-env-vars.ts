import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { NetlifyEnvVarResponse } from '../../utils/api-types.js';
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
    const envVars = await getAPIJSONResult<NetlifyEnvVarResponse[]>(`/api/v1/accounts/${teamId}/env`, {}, {}, request);

    if (envVarKey) {
      const matchingEnvVar = envVars.find((envVar) => envVar.key === envVarKey);

      if (!matchingEnvVar) {
        return JSON.stringify({ error: `No env var found matching key: ${envVarKey}` });
      }

      return JSON.stringify(matchingEnvVar);
    }

    return JSON.stringify(envVars);
  }
}
