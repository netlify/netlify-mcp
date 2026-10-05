
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { NetlifyUserResponse } from '../../utils/api-types.js';
import type { DomainTool } from '../types.js';

const getUserParamsSchema = z.object({});

export const getUserDomainTool: DomainTool<typeof getUserParamsSchema> = {
  domain: 'user',
  operation: 'get-user',
  description:
    "Get the authenticated Netlify user's own account: id, email, name, and the team (account) they belong to. Takes no arguments and always describes the caller, never another user. Use it to answer \"who am I\" or to find the current user's default team before another call.",
  inputSchema: getUserParamsSchema,
  toolAnnotations: {
    readOnlyHint: true,
  },
  cb: async (_, {request}) => {
    return JSON.stringify(await getAPIJSONResult<NetlifyUserResponse>('/api/v1/user', {}, {}, request));
  }
}
