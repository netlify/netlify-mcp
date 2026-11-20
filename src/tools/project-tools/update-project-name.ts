
import { z } from 'zod';
import { getAPIJSONResult, NetlifyApiError } from '../../utils/api-networking.js';
import type { NetlifySiteResponse } from '../../utils/api-types.js';
import type { DomainTool } from '../types.js';
import { getEnrichedSiteModelForLLM } from './project-utils.js';

const updateProjectNameParamsSchema = z.object({
  siteId: z.string(),
  name: z.string().regex(/^[a-z0-9-]+$/).describe('Name must be hyphenated alphanumeric such as "my-site" or "my-site-2"')
});

export const updateProjectNameDomainTool: DomainTool<typeof updateProjectNameParamsSchema> = {
  domain: 'project',
  operation: 'update-project-name',
  description:
    "Rename a Netlify project. The name must be hyphenated alphanumeric (for example 'my-site'). This also changes the site's netlify.app subdomain: every existing link to the old URL stops working, and the old name is released back to the shared pool where anyone can claim it, so renaming back may not be possible. Confirm the new name with the user before calling.",
  inputSchema: updateProjectNameParamsSchema,
  toolAnnotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
  cb: async ({ siteId, name }, {request}) => {

    if(name === undefined || name === '') {
      return 'You must provide a name for this site';
    }

    const site = await getAPIJSONResult<NetlifySiteResponse | string>(`/api/v1/sites/${siteId}`, {
      method: 'PUT',
      body: JSON.stringify({
        name
      })
    }, {
      failureCallback: (response) => {

        if(response.status === 422){
          throw new NetlifyApiError(422, `The project name "${name}" is already taken. Try a different name (e.g. append a number or short suffix, like "${name}-1") and retry.`);
        }

        throw new NetlifyApiError(response.status, `Failed to update project name: ${response.status}`);
      }
    }, request);

    // An empty or non-JSON success body isn't a site, so don't run it through the
    // site enricher. Thrown so the client gets an error result (isError).
    if (!site || typeof site === 'string') {
      throw new Error(site || 'Failed to update project name');
    }

    return JSON.stringify(getEnrichedSiteModelForLLM(site));
  }
}
