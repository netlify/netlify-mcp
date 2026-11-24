import { z } from 'zod';
import { getAPIJSONResult, NetlifyApiError } from '../../utils/api-networking.js';
import type { NetlifyAgentRunnerResponse, NetlifySiteResponse } from '../../utils/api-types.js';
import type { DomainTool } from '../types.js';
import { NOT_FOUND_MESSAGE, runDashboardUrl } from './agent-runner-utils.js';

const listRunsParamsSchema = z.object({
  siteId: z.string().describe('Id of the Netlify project whose runs to list.'),
  state: z
    .enum(['new', 'running', 'await_input', 'interrupted', 'done', 'error', 'cancelled', 'archived'])
    .optional()
    .describe('Only list runs in this state.'),
  limit: z.number().int().min(1).max(100).optional().describe('How many runs to return. Defaults to 20.'),
});

const failureCallback = (response: Response) => {
  if (response.status === 404) {
    return NOT_FOUND_MESSAGE;
  }
  throw new NetlifyApiError(response.status);
};

export const listRunsDomainTool: DomainTool<typeof listRunsParamsSchema> = {
  domain: 'agent-runner',
  operation: 'list-runs',
  description:
    "List the Agent Runner runs on a Netlify project, newest first. Each entry has the run id, title, state, what it is working on, when it was created, its deploy preview and pull request links, and a link to the run in the Netlify dashboard. Use it to find a run id for get-run or follow-up-run.",
  inputSchema: listRunsParamsSchema,
  toolAnnotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  cb: async ({ siteId, state, limit }, { request }) => {
    const site = await getAPIJSONResult<NetlifySiteResponse | string>(
      `/api/v1/sites/${encodeURIComponent(siteId)}`,
      {},
      { failureCallback },
      request,
    );

    if (!site || typeof site === 'string') {
      return site || 'Failed to get the project';
    }

    const params = new URLSearchParams({
      site_id: siteId,
      account_id: site.account_id ?? '',
      per_page: String(limit ?? 20),
    });
    if (state) {
      params.set('state', state);
    }

    const runs = await getAPIJSONResult<NetlifyAgentRunnerResponse[] | string>(
      `/api/v1/agent_runners?${params}`,
      {},
      { failureCallback },
      request,
    );

    if (!Array.isArray(runs)) {
      return runs || 'Failed to list the runs';
    }

    return JSON.stringify(
      runs.map((run) => ({
        runId: run.id ?? null,
        title: run.title ?? null,
        state: run.state ?? null,
        currentTask: run.current_task ?? null,
        createdAt: run.created_at ?? null,
        previewUrl: run.latest_session_deploy_url ?? null,
        prUrl: run.pr_url ?? null,
        dashboardUrl: run.id ? runDashboardUrl(site.name, run.id) : null,
      })),
    );
  },
};
