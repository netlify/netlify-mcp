
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
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
    "Rename a Netlify project. The name must be hyphenated alphanumeric (for example 'my-site'). This also changes the site's netlify.app subdomain, so any existing links to the old subdomain stop working and the old name becomes available to others.",
  inputSchema: updateProjectNameParamsSchema,
  toolAnnotations: {
    readOnlyHint: false,
    // Renames the project. The old netlify.app subdomain stops resolving, but
    // nothing is deleted and the change is reversible by renaming back.
    destructiveHint: false,
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
          return `The project name "${name}" is already taken. Try a different name (e.g. append a number or short suffix, like "${name}-1") and retry.`;
        }

        return `Failed to update project name: ${response.status}`;
      }
    }, request);

    // The failureCallback above resolves to an explanatory message instead of a
    // site, so surface it as-is rather than running it through the site enricher.
    if (!site || typeof site === 'string') {
      return site || 'Failed to update project name';
    }

    return JSON.stringify(getEnrichedSiteModelForLLM(site));
  }
}
