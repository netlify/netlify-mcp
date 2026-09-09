
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';
import { getEnrichedSiteModelForLLM } from './project-utils.js';

const updateProjectNameParamsSchema = z.object({
  siteId: z.string(),
  name: z.string().regex(/^[a-z0-9-]+$/).describe('Name must be hyphenated alphanumeric such as "my-site" or "my-site-2"')
});

export const updateProjectNameDomainTool: DomainTool<typeof updateProjectNameParamsSchema> = {
  domain: 'project',
  operation: 'update-project-name',
  inputSchema: updateProjectNameParamsSchema,
  toolAnnotations: {
    readOnlyHint: false,
  },
  cb: async ({ siteId, name }, {request}) => {

    if(name === undefined || name === '') {
      return 'You must provide a name for this site';
    }

    const site = await getAPIJSONResult(`/api/v1/sites/${siteId}`, {
      method: 'PUT',
      body: JSON.stringify({
        name
      })
    }, {
      failureCallback: (response) => {

        if(response.status === 422){
          return `The project name "${name}" is already taken. Try a different name (e.g. append a number or short suffix, like "${name}-1") and retry.`;
        }

        return `Failed to update project name: ${response.status}`;
      }
    }, request);

    if(!site || typeof site === 'string'){
      return site || 'Failed to update project name';
    }

    return JSON.stringify(getEnrichedSiteModelForLLM(site));
  }
}
