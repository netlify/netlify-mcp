
import { z } from 'zod';
import { authenticatedFetch, getAPIJSONResult, NetlifyApiError } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';
import type { NetlifyEnvVarResponse, NetlifySiteResponse } from '../../utils/api-types.js';
import { appendToLog } from '../../utils/logging.js';

const availableContexts = ['all', 'dev', 'branch-deploy', 'deploy-preview', 'production', 'branch'] as const;
// The API refuses a secret that runs in the post_processing scope.
const SECRET_DEFAULT_SCOPES = ['builds', 'functions', 'runtime'] as const;
// The API refuses a secret with the "all" context; the CLI also leaves out dev and branch.
const SECRET_DEFAULT_CONTEXTS = ['production', 'deploy-preview', 'branch-deploy'] as const;

const refusalReason = (text: string): string => {
  let reason: unknown = text.trim();
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.msg === 'string') reason = parsed.msg;
    else if (typeof parsed?.message === 'string') reason = parsed.message;
  } catch {}
  return typeof reason === 'string' ? reason.trim().slice(0, 300) : '';
};

const manageEnvVarsParamsSchema =z.object({
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
  description:
    "Read, create, update, or delete environment variables on a Netlify site. Set getAllEnvVars to list them, upsertEnvVar to create or overwrite one, or deleteEnvVar to remove one. envVarIsSecret and newVarScopes apply only when the variable is being CREATED: for a key that already exists, upsert updates the value alone and silently leaves the existing secret flag and scopes unchanged. A secret cannot use the all context or the post_processing scope, so when envVarIsSecret is set the server sends the scopes builds, functions, and runtime and the contexts production, deploy-preview, and branch-deploy, unless you set newVarScopes or newVarContext explicitly. Choosing specific newVarScopes needs a Pro plan or higher, so leave newVarScopes at all on other plans. Deleting is permanent, and a build is needed for changes to take effect.",
  inputSchema: manageEnvVarsParamsSchema,
  toolAnnotations: {
    readOnlyHint: false,
    // Includes deleting variables. Re-applying the same value is a no-op.
    destructiveHint: true,
    idempotentHint: true,
},
  cb: async ({ siteId, getAllEnvVars, deleteEnvVar, upsertEnvVar, envVarKey, envVarValue, envVarIsSecret, newVarScopes, newVarContext}, {request}) => {

    const site = await getAPIJSONResult<NetlifySiteResponse>(`/api/v1/sites/${siteId}`, {}, {}, request);
    const teamId = site?.account_id;

    if(!site || !teamId){
      return 'This site id and the team it belongs to do not exist.'
    }

    if(deleteEnvVar){
      await getAPIJSONResult<string>(`/api/v1/accounts/${teamId}/env/${envVarKey}?site_id=${siteId}`, { method: 'DELETE' }, {}, request);
      return `Environment variable deleted: ${envVarKey}`;
    }

    if(upsertEnvVar){

      const existingEnvVarResp = await authenticatedFetch(`/api/v1/accounts/${teamId}/env/${envVarKey}?site_id=${siteId}`, {}, request);

      let existingEnvVar = null;

      if (existingEnvVarResp.status === 200) {
        existingEnvVar = await existingEnvVarResp.json();
      }

      const wantsAllScopes = newVarScopes.includes('all');
      const secretScopes = !!envVarIsSecret && wantsAllScopes;
      const secretContexts = !!envVarIsSecret && newVarContext === 'all';

      let envVar = {
        key: envVarKey,
        is_secret: envVarIsSecret || false,
        scopes: secretScopes
          ? [...SECRET_DEFAULT_SCOPES]
          : (['builds', 'functions', 'runtime', 'post_processing'] as typeof newVarScopes).filter(scope => wantsAllScopes || newVarScopes.includes(scope)),
        values: secretContexts
          ? SECRET_DEFAULT_CONTEXTS.map(context => ({ context, value: envVarValue }))
          : [{ context: newVarContext || 'all', value: envVarValue }]
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
          await getAPIJSONResult<NetlifyEnvVarResponse>(`/api/v1/accounts/${teamId}/env/${envVarKey}?site_id=${siteId}`, {
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

        // A rejected create must not read as success. Check the status before
        // touching the body, so a failed body read cannot hide a known status.
        if (!resp.ok) {
          let text = '';
          try {
            text = await resp.text();
          } catch {
            throw new NetlifyApiError(resp.status);
          }
          const reason = refusalReason(text);
          if (!reason) {
            throw new NetlifyApiError(resp.status);
          }
          throw new NetlifyApiError(resp.status, `Netlify refused to create environment variable "${envVarKey}" (${resp.status}): ${reason}`);
        }
        appendToLog(`create result${resp.status} ${await resp.text()}`);
      }

      if (!existingEnvVar && (secretScopes || secretContexts)) {
        const sentContexts = envVar.values.map(value => value.context).join(', ');
        return `Environment variable upserted as a secret (scopes: ${envVar.scopes.join(', ')}; contexts: ${sentContexts})`;
      }

      return 'Environment variable upserted';
    }

    if(getAllEnvVars){
      if (siteId) {
        const envVars = await getAPIJSONResult<NetlifyEnvVarResponse[]>(`/api/v1/sites/${siteId}/env`, {}, {}, request);

        if (Array.isArray(envVarKey) && envVarKey.length > 0) {
          return JSON.stringify(envVars.find((envVar) => envVarKey === envVar.key));
        }

        return JSON.stringify(envVars);
      } else {
        return 'Please provide a siteId for selecting which env vars to fetch'
      }
    }

    return 'Please provide more details for what env vars you want to work with';
  }
}
