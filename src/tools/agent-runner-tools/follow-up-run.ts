import { z } from 'zod';
import type { NetlifyAgentRunnerSessionResponse } from '../../utils/api-types.js';
import type { DomainTool } from '../types.js';
import { CREDITS_NOTE, FOLLOW_UP_CONTEXT_NOTE, postAgentRunnerJson } from './agent-runner-utils.js';

const followUpRunParamsSchema = z.object({
  runId: z.string().describe('Id of the run to continue, from start-run or list-runs.'),
  prompt: z
    .string()
    .min(1)
    .describe(
      `What the agent should do or answer next, written as a complete task. ${FOLLOW_UP_CONTEXT_NOTE} ${CREDITS_NOTE}`,
    ),
  mode: z
    .enum(['ask', 'change'])
    .describe("'ask' answers a question and changes nothing. 'change' edits the code and builds a new deploy preview."),
});

export const followUpRunDomainTool: DomainTool<typeof followUpRunParamsSchema> = {
  domain: 'agent-runner',
  operation: 'follow-up-run',
  description: `Continue an existing Agent Runner run with a new prompt, in the same environment. It fails while a session is still running on the run: check it with get-run and wait for it to finish first. A run that has been published or is publishing takes no more prompts. ${CREDITS_NOTE} The response includes a sessionId; check the follow-up with get-run. Nothing is published to production.`,
  inputSchema: followUpRunParamsSchema,
  toolAnnotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  cb: async ({ runId, prompt, mode }, { request }) => {
    const result = await postAgentRunnerJson<NetlifyAgentRunnerSessionResponse>(
      `/api/v1/agent_runners/${encodeURIComponent(runId)}/sessions`,
      { prompt, ...(mode === 'ask' ? { mode } : {}) },
      request,
      'send the follow-up',
      { domainOperation: 'follow-up-run', mode },
    );

    if ('error' in result) return result.error;
    const session = result.data;
    if (!session) {
      return 'The follow-up may have started, but the response could not be read. Check the run with get-run.';
    }

    return JSON.stringify({
      runId,
      sessionId: session.id ?? null,
      state: session.state ?? null,
      nextStep: 'Tell the user the follow-up has started, then check its progress with get-run using the runId.',
    });
  },
};
