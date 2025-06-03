
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';
import { getEnrichedSiteModelForLLM } from './project-utils.js';
import { createToolResponseWithFollowup } from '../tool-utils.js';
import { appendToLog } from '../../utils/logging.js';

const createNewProjectParamsSchema = z.object({
  teamSlug: z.string().optional(),
  name: z.string().regex(/^[a-z0-9-]+$/).optional().describe('Name must be hyphenated alphanumeric such as "my-site" or "my-site-2"')
});

export const createNewProjectDomainTool: DomainTool<typeof createNewProjectParamsSchema> = {
  domain: 'project',
  operation: 'create-new-project',
  inputSchema: createNewProjectParamsSchema,
  cb: async ({ teamSlug, name }) => {

    const site = await getAPIJSONResult(`/api/v1/sites${teamSlug ? `?account_slug=${teamSlug}` : ''}`, {
      method: 'POST',
      body: JSON.stringify({
        name
      })
    },{
      failureCallback: (response) => {

        if (response.status === 422) {
          throw new Error('Project names have to be unique across Netlify and this project name is already taken, would you like to try a different version of that name?');
        }

        throw `Failed to create project: ${response.status}`;
      }
    });

    if(!site){
      return 'Failed to create project';
    }

    return JSON.stringify(createToolResponseWithFollowup(getEnrichedSiteModelForLLM(site), 'The site was created but the user must create a deploy to get a live url.'));
  }
}
