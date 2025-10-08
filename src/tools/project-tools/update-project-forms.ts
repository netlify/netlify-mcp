
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';
import { getEnrichedSiteModelForLLM } from './project-utils.js';

const getProjectParamsSchema = z.object({
  siteId: z.string(),
  forms: z.enum(['enabled', 'disabled']).optional(),
});

export const updateFormsDomainTool: DomainTool<typeof getProjectParamsSchema> = {
  domain: 'project',
  operation: 'update-forms',
  inputSchema: getProjectParamsSchema,
  toolAnnotations: {
    readOnlyHint: false,
  },
  cb: async ({ siteId, forms }, {request}) => {

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
    }, {}, request);

    return JSON.stringify(getEnrichedSiteModelForLLM(site));
  }
}
