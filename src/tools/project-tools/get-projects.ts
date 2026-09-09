
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { NetlifySiteResponse } from '../../utils/api-types.js';
import type { DomainTool } from '../types.js';
import { getEnrichedSiteModelForLLM } from './project-utils.js';
import { appendToLog } from '../../utils/logging.js';

const getProjectParamsSchema = z.object({
  teamSlug: z.string().optional(),
  projectNameSearchValue: z.string().optional().describe('Search for a project by partial name match'),
});

export const getProjectsDomainTool: DomainTool<typeof getProjectParamsSchema> = {
  domain: 'project',
  operation: 'get-projects',
  inputSchema: getProjectParamsSchema,
  toolAnnotations: {
    readOnlyHint: true,
  },
  cb: async ({ teamSlug, projectNameSearchValue }, {request}) => {

    let apiResults: NetlifySiteResponse[];

    if (teamSlug) {
      apiResults = await getAPIJSONResult<NetlifySiteResponse[]>(`/api/v1/${teamSlug}/sites`, {}, { pagination: true }, request);
    } else {
      apiResults = await getAPIJSONResult<NetlifySiteResponse[]>(`/api/v1/sites?filter=all&sort_by=published_at&order_by=asc${projectNameSearchValue ? `&name=${projectNameSearchValue}` : ''}`, {}, { pagination: true }, request);
    }

    const enrichedSites = getEnrichedSiteModelForLLM(apiResults);

    // if there is a large number of sites, this will be too
    // much data for the LLM context window. In this case will will
    // return a complete list with the most essential fields for
    // next step work.
    if (apiResults.length > 20){
      // id/name/url/teamId are what follow-up calls need. url and teamId live
      // under _enrichedFields on the enriched model, so reading them off the top
      // level — as this did while the result was untyped — yielded `undefined`
      // for both and JSON.stringify dropped them.
      return JSON.stringify(enrichedSites.map((site) => ({
        id: site.id,
        name: site.name,
        url: site._enrichedFields.urls.primarySiteUrl,
        teamId: site._enrichedFields.teamId,
      })));
    }

    return JSON.stringify(enrichedSites);
  }
}
