import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getCodingContextTopics, getNetlifyCodingContext } from './coding-context.ts';
import { checkCompatibility } from '../utils/compatibility.ts';
import { log } from '../../netlify/functions/mcp-server/logger.js';

export async function registerCodingContextTool(
  server: McpServer,
  opts: { name: string; description: string },
): Promise<void> {
  const topics = await getCodingContextTopics();

  // With no topics (e.g. the skills manifest failed to fetch), z.enum([])
  // yields an uncallable tool: its required creationType can satisfy no value.
  // Skip registration until topics become available.
  if (topics.length === 0) {
    log.error('Skipping coding-context tool registration: no topics available', { tool: opts.name });
    return;
  }

  server.registerTool(
    opts.name,
    {
      description: opts.description,
      inputSchema: {
        creationType: z.enum(topics as [string, ...string[]]),
        reference: z
          .string()
          .optional()
          .describe(
            'Optional. Path of one of the skill\'s reference files (for example "references/migrations.md"), as listed at the end of the main response for that creationType. Omit to get the main skill guidance.',
          ),
      },
      // All four hints explicit: the spec defaults destructiveHint and
      // openWorldHint to true when omitted, so declaring only readOnlyHint
      // published this as implicitly destructive. It fetches context over the
      // public internet, which is open-world under OpenAI's rubric (see
      // completeToolAnnotations).
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ creationType, reference }) => {
      checkCompatibility();
      const result = await getNetlifyCodingContext(creationType, reference);
      if (result.ok) {
        return { content: [{ type: 'text' as const, text: result.text }] };
      }
      return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    },
  );
}
