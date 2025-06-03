import { z } from 'zod';
import type { DomainTool } from '../types.js';
import { getExtensions } from './extension-utils.js';

const getExtensionsParamsSchema = z.object({});

export const getExtensionsDomainTool: DomainTool<typeof getExtensionsParamsSchema> = {
  domain: 'extension',
  operation: 'get-extensions',
  inputSchema: getExtensionsParamsSchema,
  cb: async () => {
    return JSON.stringify({
      context: 'This list of extensions is available to any Netlify team. This list DOES NOT inform if the extension is installed or configured for a particular team or account.',
      extensions: await getExtensions()
    });
  }
}
