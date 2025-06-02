
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';
import { getEnrichedSiteModelForLLM } from './project-utils.js';

// historically, everything has been "site" but we are moving to
// presenting these as projects. Ids and such will be mapped to sites
// on the PI level
const domain = 'project';

const getProjectParamsSchema = z.object({
  siteId: z.string(),
  appliesTo: z.enum(['all-projects', 'non-production-projects']).describe('Which project context this rule applies to'),
  requireSSOTeamLogin: z.boolean().optional(),
  requirePassword: z.boolean().optional(),
  passwordValue: z.string().optional(),
});

export const updateVisitorAccessControlsDomainTool: DomainTool<typeof getProjectParamsSchema> = {
  domain,
  operation: 'update-visitor-access-controls',
  inputSchema: getProjectParamsSchema,
  cb: async ({ siteId, appliesTo, requireSSOTeamLogin, requirePassword, passwordValue }) => {

    if(requireSSOTeamLogin === undefined && requirePassword === undefined) {
      return 'You must provide either requireSSOTeamLogin or requirePassword';
    }

    const updatePayload: Record<string, any> = {
      password: "",
      password_context: 'all',
      sso_login: false,
      sso_login_context: 'all'
    }

    if(requirePassword){
      if(passwordValue === undefined){
        return 'You must provide a password value when requirePassword is true';
      }
      updatePayload.password = passwordValue;
      updatePayload.password_context = appliesTo === 'all-projects' ? 'all' : 'non_production';
    }else if(requireSSOTeamLogin){
      updatePayload.sso_login = true;
      updatePayload.sso_login_context = appliesTo === 'all-projects' ? 'all' : 'non_production';
    }else {
      // else case is handled by the default values and will unset the
      // access controls
    }

    const site = await getAPIJSONResult(`/api/v1/sites/${siteId}`, {
      method: 'PUT',
      body: JSON.stringify(updatePayload)
    });

    return JSON.stringify(getEnrichedSiteModelForLLM(site));
  }
}
