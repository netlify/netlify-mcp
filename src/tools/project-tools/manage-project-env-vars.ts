
import { z } from 'zod';
import { authenticatedFetch, getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';
import { appendToLog } from '../../utils/logging.js';

// historically, everything has been "site" but we are moving to
// presenting these as projects. Ids and such will be mapped to sites
// on the PI level
const domain = 'project';

const manageEnvVarsParamsSchema = z.object({
  getAllEnvVars: z.boolean().optional(),
  deleteEnvVar: z.boolean().optional(),
  upsertEnvVar: z.boolean().optional(),
  siteId: z.string(),
  envVarKey: z.string().optional(),
  envVarIsSecret: z.boolean().optional(),

  envVarValue: z.string().optional(),
  newVarScopes: z.array(z.enum(['all', 'builds', 'functions', 'runtime', 'post_processing'])).optional().default(['all']),
  newVarContext: z.enum(['all', 'dev', 'branch-deploy', 'deploy-preview', 'production', 'branch']).optional().default('all'),
});

export const manageEnvVarsDomainTool: DomainTool<typeof manageEnvVarsParamsSchema> = {
  domain,
  operation: 'manage-env-vars',
  inputSchema: manageEnvVarsParamsSchema,
  cb: async ({ siteId, getAllEnvVars, deleteEnvVar, upsertEnvVar, envVarKey, envVarValue, envVarIsSecret, newVarScopes, newVarContext}) => {

    const site = await getAPIJSONResult(`/api/v1/sites/${siteId}`);
    const teamId = site?.account_id;

    if(!site || !teamId){
      return 'This site id and the team it belongs to do not exist.'
    }

    if(deleteEnvVar){
      await getAPIJSONResult(`/api/v1/accounts/${teamId}/env/${envVarKey}?site_id=${siteId}`, { method: 'DELETE' });
      return `Environment variable deleted: ${envVarKey}`;
    }

    if(upsertEnvVar){

      const existingEnvVarResp = await authenticatedFetch(`/api/v1/accounts/${teamId}/env/${envVarKey}?site_id=${siteId}`);

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

        // TODO: we need to handle updates where the original var is "all" so we have to
        // spread the values throughout.
        // update specific contexts if defined
        // otherwise, update the env var for all contexts
        if(newVarContext !== 'all'){
          envVar = existingEnvVar;
          envVar.values = envVar.values.map(value => {
            if(value.context === newVarContext){
              value.value = envVarValue;
            }
            return value;
          });
        }

        await getAPIJSONResult(`/api/v1/accounts/${teamId}/env/${envVarKey}?site_id=${siteId}`, {
          method: 'PUT',
          body: JSON.stringify(envVar)
        });
      } else {

        const resp = await authenticatedFetch(`/api/v1/accounts/${teamId}/env?site_id=${siteId}`, {
          method: 'POST',
          body: JSON.stringify([envVar])
        });

        appendToLog(`create result${resp.status} ${await resp.text()}`);
      }

      return 'Environment variable upserted';
    }

    if(getAllEnvVars){
      if (siteId) {
        const envVars = await getAPIJSONResult(`/api/v1/sites/${siteId}/env`);

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
