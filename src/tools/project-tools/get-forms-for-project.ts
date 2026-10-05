
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { NetlifyFormResponse } from '../../utils/api-types.js';
import type { DomainTool } from '../types.js';

const getFormsForProjectParamsSchema = z.object({
  siteId: z.string(),
  formId: z.string().optional()
});

export const getFormsForProjectDomainTool: DomainTool<typeof getFormsForProjectParamsSchema> = {
  domain: 'project',
  operation: 'get-forms-for-project',
  description:
    "List the Netlify Forms defined on a site, or get one form by id, including each form's name and submission count. Use it to find a form id before reading or deleting its submissions.",
  inputSchema: getFormsForProjectParamsSchema,
  toolAnnotations: {
    readOnlyHint: true,
  },
  cb: async ({ siteId, formId }, {request}) => {
    const forms = await getAPIJSONResult<NetlifyFormResponse[]>(`/api/v1/sites/${siteId}/forms`, {}, {}, request);

    if(formId && Array.isArray(forms)) {
      return JSON.stringify(forms.find(form => form.id === formId) || 'form with id does not exist');
    }

    return JSON.stringify(forms);
  }
}
