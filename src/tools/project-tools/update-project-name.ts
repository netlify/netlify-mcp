
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';
import { getEnrichedSiteModelForLLM } from './project-utils.js';

// historically, everything has been "site" but we are moving to
// presenting these as projects. Ids and such will be mapped to sites
// on the PI level
const domain = 'project';

const updateProjectNameParamsSchema = z.object({
  siteId: z.string(),
  name: z.string().regex(/^[a-z0-9-]+$/).describe('Name must be hyphenated alphanumeric such as "my-site" or "my-site-2"')
});

export const updateProjectNameDomainTool: DomainTool<typeof updateProjectNameParamsSchema> = {
  domain,
  operation: 'update-project-name',
  inputSchema: updateProjectNameParamsSchema,
  cb: async ({ siteId, name }) => {

    if(name === undefined || name === '') {
      return 'You must provide a name for this site';
    }

    const site = await getAPIJSONResult(`/api/v1/sites/${siteId}`, {
      method: 'PUT',
      body: JSON.stringify({
        name
      })
    });

    return JSON.stringify(getEnrichedSiteModelForLLM(site));
  }
}
