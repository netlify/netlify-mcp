// coding context
// focus tools on domain + focused operations
// tool domains:
//  [] site (includes builds, domains, forms, env vars, settings,)
//    [] builds
//    [] domains
//    [x] forms
//    [] env vars
//    [x] access controls
//    [] settings
//  [] deploy
//    [x] build + deploy
//    [] rollback/deploy selection
//  [x] user-and-team
//    [x] user
//    [x] team
//    [] team env vars
//  [] sites aggregate operations
//  [] extensions
//  [] database?
//
// return errors when missing data and how the agent can get the data


import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { userDomainTools } from './user-tools/index.js';
import { deployDomainTools } from './deploy-tools/index.js';
import { teamDomainTools } from './team-tools/index.js';
import { projectDomainTools } from './project-tools/index.js';
import { checkCompatibility } from '../utils/compatibility.js';
import { getNetlifyAccessToken } from '../utils/api-networking.js';
import { appendToLog } from '../utils/logging.js';
import { z } from 'zod';
import type { DomainTool } from './types.js';

const listOfDomainTools = [userDomainTools, deployDomainTools, teamDomainTools, projectDomainTools];

export const bindTools = async (server: McpServer) => {

  const toSelectorSchema = (domainTool: DomainTool<z.ZodType<any>>) => {
    return z.object({
      // domain: z.literal(domainTool.domain),
      operation: z.literal(domainTool.operation),
      params: domainTool.inputSchema,

      llmModelName: z.string().optional(),
      aiAgentName: z.string().optional()
    });
  }

  listOfDomainTools.forEach(domainTools => {

    const domain = domainTools[0].domain;

    // join the input schemas of all domain tools into a raw array with
    // to give the llm the ability to select.
    const paramsSchema = {
      // @ts-ignore
      selectSchema: domainTools.length > 1 ? z.union(domainTools.map(tool => toSelectorSchema(tool))) : toSelectorSchema(domainTools[0])
    };

    const toolName = `ntl-${domain}-operations`;
    const toolDescription = `Run one of the following operations ${domainTools.map(tool => tool.operation).join(', ')}`;

    server.tool(toolName, toolDescription, paramsSchema, async (...args) => {
      checkCompatibility();

      try {
        await getNetlifyAccessToken();
      } catch (error: any) {
        return {
          content: [{ type: "text", text: error?.message || 'Failed to get Netlify token' }],
          isError: true
        };
      }

      // return await tool.cb(...args);

      appendToLog(`${toolName} operation: ${JSON.stringify(args)}`);

      const selectedSchema = args[0]?.selectSchema;

      if (!selectedSchema) {
        return {
          content: [{ type: "text", text: 'Failed to select a valid operation. Retry the MCP operation but select the operation and provide the right inputs.' }]
        }
      }

      const operation = selectedSchema.operation;

      const subtool = domainTools.find(subtool => subtool.operation === operation);

      if (!subtool) {
        return {
          content: [{ type: "text", text: 'Agent called the wrong MCP tool for this operation.' }]
        }
      }

      const result = await subtool.cb(selectedSchema.params);

      appendToLog(`${domain} operation result: ${JSON.stringify(result)}`);

      return {
        content: [{ type: "text", text: JSON.stringify(result) }]
      }
    });
  });
};

