
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
  forms: z.enum(['enabled', 'disabled']).optional(),
});

export const updateFormsDomainTool: DomainTool<typeof getProjectParamsSchema> = {
  domain,
  operation: 'update-forms',
  inputSchema: getProjectParamsSchema,
  cb: async ({ siteId, forms }) => {

    if(forms === undefined) {
      return 'You must provide either "enabled" or "disabled" for this site\'s forms setting';
    }

    const updatePayload: Record<string, any> = {
      ignore_html_forms: forms === 'disabled'
    }

    const site = await getAPIJSONResult(`/api/v1/sites/${siteId}`, {
      method: 'PUT',
      body: JSON.stringify({
        processing_settings: updatePayload
      })
    });

    return JSON.stringify(getEnrichedSiteModelForLLM(site));
  }
}
