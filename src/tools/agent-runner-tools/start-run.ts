import { z } from 'zod';
import type { NetlifyAgentRunnerResponse } from '../../utils/api-types.js';
import type { DomainTool } from '../types.js';
import { CREDITS_NOTE, HANDOFF_RULE, PROMPT_CONTEXT_NOTE, postAgentRunnerJson, toApiMode } from './agent-runner-utils.js';

const startRunParamsSchema = z.object({
  siteId: z.string().describe('Id of the Netlify project to run against.'),
  prompt: z
    .string()
    .min(1)
    .describe(
      `What the agent should do or answer, written as a complete task. ${PROMPT_CONTEXT_NOTE} ${HANDOFF_RULE} ${CREDITS_NOTE}`,
    ),
  mode: z
    .enum(['ask', 'change', 'create'])
    .describe(
      "'ask' answers a question about the project and changes nothing. 'change' edits the code and builds a deploy preview. 'create' builds a new site from a description; use it on an empty project, such as one just made with create-new-project.",
    ),
  branch: z.string().optional().describe('Branch to start from. Defaults to the main branch.'),
  deployId: z.string().optional().describe('A deploy of this project to start from instead of a branch.'),
});

export const startRunDomainTool: DomainTool<typeof startRunParamsSchema> = {
  domain: 'agent-runner',
  operation: 'start-run',
  description: `Start an Agent Runner run. ${HANDOFF_RULE} Modes: 'ask' answers a question about the project and changes nothing; 'change' edits the code and builds a deploy preview; 'create' builds a new site from a description. To build a site from scratch, first make an empty project with create-new-project, then start a run in 'create' mode on it. ${PROMPT_CONTEXT_NOTE} ${CREDITS_NOTE} The response includes a runId: pass it to get-run to follow the run. Nothing is published to production.`,
  inputSchema: startRunParamsSchema,
  toolAnnotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  cb: async ({ siteId, prompt, mode, branch, deployId }, { request }) => {
    const result = await postAgentRunnerJson<NetlifyAgentRunnerResponse>(
      `/api/v1/agent_runners?site_id=${encodeURIComponent(siteId)}`,
      {
        prompt,
        mode: toApiMode(mode),
        ...(branch ? { branch } : {}),
        ...(deployId ? { deploy_id: deployId } : {}),
      },
      request,
      'start the run',
    );

    if ('error' in result) return result.error;
    const run = result.data;
    if (!run) {
      return 'The run may have started, but the response could not be read. Check recent runs with list-runs.';
    }

    return JSON.stringify({
      runId: run.id ?? null,
      siteId: run.site_id ?? siteId,
      title: run.title ?? null,
      state: run.state ?? null,
      nextStep: 'Tell the user the run has started, then check its progress with get-run using the runId.',
    });
  },
};
