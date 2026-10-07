import { z } from 'zod';
import type { NetlifyAgentRunnerSessionResponse } from '../../utils/api-types.js';
import type { DomainTool } from '../types.js';
import { postAgentRunnerJson } from './agent-runner-utils.js';

const answerRunQuestionParamsSchema = z.object({
  runId: z.string().describe('Id of the run that is waiting on an answer.'),
  sessionId: z.string().describe("The pendingQuestion.sessionId from get-run."),
  refId: z.string().describe('The pendingQuestion.refId from get-run.'),
  answers: z
    .array(z.union([z.string(), z.array(z.string()), z.null()]))
    .min(1)
    .optional()
    .describe('One entry per question, in order: a string, an array of strings for multi-select, or null to skip that question.'),
  skip: z
    .boolean()
    .optional()
    .describe('Skip the whole question instead of answering. The only option for a request to connect a service.'),
  instruction: z.string().optional().describe('Optional note to the agent when skipping.'),
});

export const answerRunQuestionDomainTool: DomainTool<typeof answerRunQuestionParamsSchema> = {
  domain: 'agent-runner',
  operation: 'answer-run-question',
  description:
    "Answer a question an Agent Runner run is waiting on, so the run resumes. Get the sessionId, refId, and the questions from get-run's pendingQuestion, ask the user, then pass either answers (one entry per question, in order) or skip: true, not both. A request to connect a service can only be skipped, with an optional instruction for the agent. The user connects services from the run's dashboard link.",
  inputSchema: answerRunQuestionParamsSchema,
  toolAnnotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  cb: async ({ runId, sessionId, refId, answers, skip, instruction }, { request }) => {
    const hasAnswers = answers !== undefined;
    if (hasAnswers === (skip === true)) {
      return 'Provide either answers (a non-empty list, one entry per question) or skip: true, but not both.';
    }

    const result = await postAgentRunnerJson<NetlifyAgentRunnerSessionResponse>(
      `/api/v1/agent_runners/${encodeURIComponent(runId)}/sessions/${encodeURIComponent(sessionId)}/answers`,
      hasAnswers ? { refId, response: answers } : { refId, skipped: true, ...(instruction ? { instruction } : {}) },
      request,
      'send the answer',
    );

    if ('error' in result) return result.error;
    if (!result.data) {
      return 'The answer may have been accepted, but the response could not be read. Check the run with get-run.';
    }

    return JSON.stringify({
      runId,
      sessionId,
      state: result.data.state ?? null,
      nextStep: 'Tell the user the run is resuming, then check its progress with get-run using the runId.',
    });
  },
};
