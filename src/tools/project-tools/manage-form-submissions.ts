
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';

const manageFormSubmissionsParamsSchema = z.object({
  action: z.enum(['get-submissions', 'delete-submission']),
  siteId: z.string().optional(),
  formId: z.string().optional(),
  limit: z.number().optional().default(20),
  offset: z.number().optional().default(0),
  submissionId: z.string().optional(),
});

export const manageFormSubmissionsDomainTool: DomainTool<typeof manageFormSubmissionsParamsSchema> = {
  domain: 'project',
  operation: 'manage-form-submissions',
  inputSchema: manageFormSubmissionsParamsSchema,
  cb: async ({ formId, siteId, limit, offset, action, submissionId }) => {

    if(action === 'delete-submission'){
      await getAPIJSONResult(`/api/v1/submissions/${submissionId}`, { method: 'DELETE' });
      return 'Submission deleted';
    }

    // avoid unbounded requests
    let pageLimit = 100;
    const pageSize = 20;

    if (limit) {
      pageLimit = Math.floor(limit / pageSize);
      // protect against too many requests
      if(pageLimit < 1 || pageLimit > 500) {
        pageLimit = 100;
      }
    }

    let apiResults;

    if (formId) {
      apiResults = await getAPIJSONResult(`/api/v1/forms/${formId}/submissions`, {}, { pagination: true, pageLimit, pageSize, pageOffset: offset });
    } else if (siteId) {
      apiResults = await getAPIJSONResult(`/api/v1/sites/${siteId}/submissions`, {}, { pagination: true, pageLimit, pageSize, pageOffset: offset });
    } else {
      return 'Please provide a formId or siteId for selecting which form submissions to fetch'
    }

    return JSON.stringify(apiResults);
  }
}
