
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
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
  cb: async ({ teamSlug, projectNameSearchValue }) => {

    let apiResults;

    if (teamSlug) {
      apiResults = await getAPIJSONResult(`/api/v1/${teamSlug}/sites`, {}, { pagination: true });
    } else {
      apiResults = await getAPIJSONResult(`/api/v1/sites?filter=all&sort_by=published_at&order_by=asc${projectNameSearchValue ? `&name=${projectNameSearchValue}` : ''}`, {}, { pagination: true });
    }

    const enrichedSites = getEnrichedSiteModelForLLM(apiResults);

    // if there is a large number of sites, this will be too
    // much data for the LLM context window. In this case will will
    // return a complete list with the most essential fields for
    // next step work.
    if (apiResults.length > 20){
      const fields = ['id', 'name', 'url', 'teamId'];
      return JSON.stringify(enrichedSites.map((site: any) => {
        return fields.reduce((acc: Record<typeof fields[number], any>, field) => {
          acc[field] = site[field] as any;
          return acc;
        }, {});
      }));
    }

    return JSON.stringify(enrichedSites);
  }
}
