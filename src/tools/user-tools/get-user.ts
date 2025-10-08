
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';

const getUserParamsSchema = z.object({});

export const getUserDomainTool: DomainTool<typeof getUserParamsSchema> = {
  domain: 'user',
  operation: 'get-user',
  inputSchema: getUserParamsSchema,
  toolAnnotations: {
    readOnlyHint: true,
  },
  cb: async (_, {request}) => {
    return JSON.stringify(await getAPIJSONResult('/api/v1/user', {}, {}, request));
  }
}
