
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { NetlifySiteResponse } from '../../utils/api-types.js';
import type { DomainTool } from '../types.js';
import { getEnrichedSiteModelForLLM } from './project-utils.js';

const getProjectParamsSchema = z.object({
  siteId: z.string(),
  appliesTo: z.enum(['all-projects', 'non-production-projects']).describe('Which project context this rule applies to'),
  requireSSOTeamLogin: z.boolean().optional(),
  requirePassword: z.boolean().optional(),
  passwordValue: z.string().optional(),
});

export const updateVisitorAccessControlsDomainTool: DomainTool<typeof getProjectParamsSchema> = {
  domain: 'project',
  operation: 'update-visitor-access-controls',
  description:
    "Control who can view a Netlify site by requiring EITHER SSO team login OR a site password — not both. This call replaces the site's whole visitor-access configuration: requiring a password clears any SSO requirement and vice versa, and omitting both is rejected. To remove all protection and make the site publicly visible, pass requirePassword: false, requireSSOTeamLogin: false, or both. If both are requested as true the password takes effect and SSO is turned off. passwordValue is required whenever requirePassword is true. Scope the rule to all deploys or to non-production deploys only with appliesTo.",
  inputSchema: getProjectParamsSchema,
  toolAnnotations: {
    readOnlyHint: false,
    // Changes who can view the site. No data is deleted and any control can be
    // re-applied, so this is a configuration change rather than a destructive one.
    destructiveHint: false,
    idempotentHint: true,
},
  cb: async ({ siteId, appliesTo, requireSSOTeamLogin, requirePassword, passwordValue }, {request}) => {

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

    const site = await getAPIJSONResult<NetlifySiteResponse>(`/api/v1/sites/${siteId}`, {
      method: 'PUT',
      body: JSON.stringify(updatePayload)
    }, {}, request);

    return JSON.stringify(getEnrichedSiteModelForLLM(site));
  }
}
