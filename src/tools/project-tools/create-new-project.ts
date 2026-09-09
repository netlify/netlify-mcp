
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { NetlifySiteResponse } from '../../utils/api-types.js';
import type { DomainTool } from '../types.js';
import { getEnrichedSiteModelForLLM } from './project-utils.js';
import { createToolResponseWithFollowup } from '../tool-utils.js';

const createNewProjectParamsSchema = z.object({
  teamSlug: z.string().optional(),
  name: z.string().regex(/^[a-z0-9-]+$/).optional().describe('Name must be hyphenated alphanumeric such as "my-site" or "my-site-2"')
});

// Site names collide often enough (short, common words) that failing outright
// is bad UX. Retry a couple of times with a random suffix before giving up.
const MAX_NAME_CONFLICT_RETRIES = 2;
const randomNameSuffix = () => Math.random().toString(36).slice(2, 6);

export const createNewProjectDomainTool: DomainTool<typeof createNewProjectParamsSchema> = {
  domain: 'project',
  operation: 'create-new-project',
  inputSchema: createNewProjectParamsSchema,
  toolAnnotations: {
    readOnlyHint: false,
  },
  cb: async ({ teamSlug, name: requestedName }, {request}) => {

    let attemptName = requestedName;
    let renamedDueToConflict = false;

    for (let attempt = 0; attempt <= MAX_NAME_CONFLICT_RETRIES; attempt++) {

      let wasNameConflict = false;
      // Only this attempt's outcome is retryable — the same condition the
      // retry branch below checks. A 422 here is expected and about to be
      // silently retried, so it shouldn't log as a failure; a 422 on the
      // final attempt is a real, reported failure and should still log.
      const conflictIsRetryable = !!requestedName && attempt < MAX_NAME_CONFLICT_RETRIES;

      const site = await getAPIJSONResult<NetlifySiteResponse>(`/api/v1/sites${teamSlug ? `?account_slug=${teamSlug}` : ''}`, {
        method: 'POST',
        body: JSON.stringify({
          name: attemptName
        })
      },{
        quietStatuses: conflictIsRetryable ? [422] : undefined,
        failureCallback: (response) => {

          if (response.status === 422) {
            // Signal the conflict to the retry loop below without returning a
            // message yet — we only surface text once we know whether we can
            // still retry.
            wasNameConflict = true;
            return;
          }

          return `Failed to create project: ${response.status}`;
        }
      }, request);

      if (wasNameConflict) {
        if (requestedName && attempt < MAX_NAME_CONFLICT_RETRIES) {
          renamedDueToConflict = true;
          attemptName = `${requestedName}-${randomNameSuffix()}`;
          continue;
        }

        return requestedName
          ? `The name "${requestedName}" was already taken, and a couple of auto-generated variations were too. Try a more distinctive name and retry.`
          : `Netlify couldn't generate a unique project name. Retry, or provide a specific name.`;
      }

      if (!site || typeof site === 'string') {
        return site || 'Failed to create project';
      }

      const followup = renamedDueToConflict
        ? `The requested name "${requestedName}" wasn't available, so the project was created as "${attemptName}" instead. Tell the user their requested name was taken and this name was used instead — they can rename it anytime by asking.`
        : 'The site was created but the user must create a deploy to get a live url.';

      return JSON.stringify(createToolResponseWithFollowup(getEnrichedSiteModelForLLM(site), followup));
    }

    // Unreachable: the loop above always returns on its final iteration.
    return 'Failed to create project';
  }
}
