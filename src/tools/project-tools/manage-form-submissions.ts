
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';

// historically, everything has been "site" but we are moving to
// presenting these as projects. Ids and such will be mapped to sites
// on the PI level
const domain = 'project';

const manageFormSubmissionsParamsSchema = z.object({
  action: z.enum(['get-submissions', 'delete-submission']),
  siteId: z.string().optional(),
  formId: z.string().optional(),
  limit: z.number().optional().default(20),
  offset: z.number().optional().default(0),
  submissionId: z.string().optional(),
});

export const manageFormSubmissionsDomainTool: DomainTool<typeof manageFormSubmissionsParamsSchema> = {
  domain,
  operation: 'manage-form-submissions',
  inputSchema: manageFormSubmissionsParamsSchema,
  cb: async ({ formId, siteId, limit, offset, action, submissionId }) => {

    if(action === 'delete-submission'){
      await getAPIJSONResult(`/api/v1/submissions/${submissionId}`, { method: 'DELETE' });
      return 'Submission deleted';
    }

    let apiResults = [];
    let page = 1;

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

    if (offset) {
      page = Math.floor(offset / pageSize);
    }

    while (true) {

      let result;

      if (formId) {
        result =  await getAPIJSONResult(`/api/v1/forms/${formId}/submissions?page=${page}&page_size=${pageSize}`);
      }else if(siteId) {
        result = await getAPIJSONResult(`/api/v1/sites/${siteId}/submissions?page=${page}&page_size=${pageSize}`);
      }else {
        return 'Please provide a formId or siteId for selecting which form submissions to fetch'
      }

      if (Array.isArray(result)) {

        apiResults.push(...result);

        page++;

        if (result.length < pageSize || page > pageLimit) {
          break;
        }

      } else {
        break;
      }
    }

    return JSON.stringify(apiResults);
  }
}
