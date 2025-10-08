
import { z } from 'zod';
import { authenticatedFetch, getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';
import { appendToLog } from '../../utils/logging.js';

const availableContexts = ['all', 'dev', 'branch-deploy', 'deploy-preview', 'production', 'branch'] as const;
const manageEnvVarsParamsSchema = z.object({
  getAllEnvVars: z.boolean().optional(),
  deleteEnvVar: z.boolean().optional(),
  upsertEnvVar: z.boolean().optional(),
  siteId: z.string(),
  envVarKey: z.string().optional(),
  envVarIsSecret: z.boolean().optional(),

  envVarValue: z.string().optional(),
  newVarScopes: z.array(z.enum(['all', 'builds', 'functions', 'runtime', 'post_processing'])).optional().default(['all']),
  newVarContext: z.enum(availableContexts).optional().default('all'),
});

export const manageEnvVarsDomainTool: DomainTool<typeof manageEnvVarsParamsSchema> = {
  domain: 'project',
  operation: 'manage-env-vars',
  inputSchema: manageEnvVarsParamsSchema,
  toolAnnotations: {
    readOnlyHint: false,
  },
  cb: async ({ siteId, getAllEnvVars, deleteEnvVar, upsertEnvVar, envVarKey, envVarValue, envVarIsSecret, newVarScopes, newVarContext}, {request}) => {

    const site = await getAPIJSONResult(`/api/v1/sites/${siteId}`, {}, {}, request);
    const teamId = site?.account_id;

    if(!site || !teamId){
      return 'This site id and the team it belongs to do not exist.'
    }

    if(deleteEnvVar){
      await getAPIJSONResult(`/api/v1/accounts/${teamId}/env/${envVarKey}?site_id=${siteId}`, { method: 'DELETE' }, {}, request);
      return `Environment variable deleted: ${envVarKey}`;
    }

    if(upsertEnvVar){

      const existingEnvVarResp = await authenticatedFetch(`/api/v1/accounts/${teamId}/env/${envVarKey}?site_id=${siteId}`, {}, request);

      let existingEnvVar = null;

      if (existingEnvVarResp.status === 200) {
        existingEnvVar = await existingEnvVarResp.json();
      }

      let envVar = {
        key: envVarKey,
        is_secret: envVarIsSecret || false,
        scopes: (['builds', 'functions', 'runtime', 'post_processing'] as typeof newVarScopes).filter(scope => newVarScopes[0] === 'all' || newVarScopes.includes(scope)),
        values: [{ context: newVarContext || 'all', value: envVarValue }]
      }

      appendToLog(`manage env vars for siteId: ${siteId}, teamId: ${teamId}, ${JSON.stringify({envVar, existingEnvVar})}`);

      if (existingEnvVar) {

        const contextsToUpdate: (typeof availableContexts[number])[] = [];

        if(newVarContext === 'all'){
          contextsToUpdate.push(...(availableContexts).filter(context => context !== 'all'));
        }else {
          contextsToUpdate.push(newVarContext);
        }

        for(const context of contextsToUpdate){
          await getAPIJSONResult(`/api/v1/accounts/${teamId}/env/${envVarKey}?site_id=${siteId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              context,
              value: envVarValue
            })
          }, {}, request);
        }
      } else {
        const resp = await authenticatedFetch(`/api/v1/accounts/${teamId}/env?site_id=${siteId}`, {
          method: 'POST',
          body: JSON.stringify([envVar])
        }, request);

        appendToLog(`create result${resp.status} ${await resp.text()}`);
      }

      return 'Environment variable upserted';
    }

    if(getAllEnvVars){
      if (siteId) {
        const envVars = await getAPIJSONResult(`/api/v1/sites/${siteId}/env`, {}, {}, request);

        if (Array.isArray(envVarKey) && envVarKey.length > 0) {
          return JSON.stringify(envVars.find((envVar: any) => envVarKey === envVar.key));
        }

        return JSON.stringify(envVars);
      } else {
        return 'Please provide a siteId for selecting which env vars to fetch'
      }
    }

    return 'Please provide more details for what env vars you want to work with';
  }
}
