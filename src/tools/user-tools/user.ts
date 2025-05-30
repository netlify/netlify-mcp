
import { z } from 'zod';
import { getAPIJSONResult } from '../../utils/api-networking.js';
import type { DomainTool } from '../types.js';

const domain = 'user';

const getUserParamsSchema = z.object({});

const getUserDomainTool: DomainTool<typeof getUserParamsSchema> = {
  domain,
  operation: 'get-user',
  inputSchema: getUserParamsSchema,
  cb: async () => {
    return JSON.stringify(await getAPIJSONResult('/api/v1/user'));
  }
}

export const userDomainTools = [getUserDomainTool]
