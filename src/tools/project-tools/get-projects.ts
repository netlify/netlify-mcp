
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';
import { getEnrichedSiteModelForLLM } from './project-utils.js';
import { appendToLog } from '../../utils/logging.js';

// historically, everything has been "site" but we are moving to
// presenting these as projects. Ids and such will be mapped to sites
// on the PI level
const domain = 'project';

const getProjectParamsSchema = z.object({
  teamSlug: z.string().optional(),
  projectNameSearchValue: z.string().optional(),
});

export const getProjectsDomainTool: DomainTool<typeof getProjectParamsSchema> = {
  domain,
  operation: 'get-projects',
  inputSchema: getProjectParamsSchema,
  cb: async ({ teamSlug, projectNameSearchValue }) => {

    let apiResults = [];
    let page = 1;

    // avoid unbounded requests
    let pageLimit = 100;
    const pageSize = 20;

    while (true) {

      let result;

      if (teamSlug) {
        result = await getAPIJSONResult(`/api/v1/${teamSlug}/sites?page=${page}&page_size=${pageSize}`);
      }else {
        result = await getAPIJSONResult(`/api/v1/sites?filter=all&sort_by=published_at&order_by=asc${projectNameSearchValue ? `&name=${projectNameSearchValue}` : ''}&page=${page}&page_size=${pageSize}`);
      }

      if (Array.isArray(result)) {

        apiResults.push(...result);

        appendToLog(`Fetched page ${page}, received ${result.length} sites, total ${apiResults.length}`);

        page++;

        if (result.length < pageSize || page > pageLimit) {
          break;
        }

      } else {
        break;
      }
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
