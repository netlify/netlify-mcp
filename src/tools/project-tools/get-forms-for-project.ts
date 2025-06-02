
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';

// historically, everything has been "site" but we are moving to
// presenting these as projects. Ids and such will be mapped to sites
// on the PI level
const domain = 'project';

const getFormsForProjectParamsSchema = z.object({
  siteId: z.string(),
  formId: z.string().optional()
});

export const getFormsForProjectDomainTool: DomainTool<typeof getFormsForProjectParamsSchema> = {
  domain,
  operation: 'get-forms-for-project',
  inputSchema: getFormsForProjectParamsSchema,
  cb: async ({ siteId, formId }) => {
    const forms = await getAPIJSONResult(`/api/v1/sites/${siteId}/forms`);

    if(formId && Array.isArray(forms)) {
      return JSON.stringify(forms.find(form => form.id === formId) || 'form with id does not exist');
    }

    return JSON.stringify(forms);
  }
}
