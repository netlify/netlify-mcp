
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
          return 'Project names have to be unique across Netlify and this project name is already taken, would you like to try a different version of that name?';
        }

        return `Failed to update project name: ${response.status}`;
      }
    }, request);

    return JSON.stringify(getEnrichedSiteModelForLLM(site));
  }
}
