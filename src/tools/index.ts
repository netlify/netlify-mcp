// coding context
// focus tools on domain + focused operations
// tool domains:
//  [] site (includes builds, domains, forms, env vars, settings,)
//    [] builds - why did it fail
//    [] domains
//    [x] forms
//    [x] env vars
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
//  [x] extensions - install and link - not configuration
//  [] database
//
// return errors when missing data and how the agent can get the data


import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { userDomainTools } from './user-tools/index.js';
import { deployDomainTools } from './deploy-tools/index.js';
import { teamDomainTools } from './team-tools/index.js';
import { projectDomainTools } from './project-tools/index.js';
import { extensionDomainTools } from './extension-tools/index.js';
import { checkCompatibility } from '../utils/compatibility.js';
import { getNetlifyAccessToken, NetlifyUnauthError } from '../utils/api-networking.js';
import { appendToLog } from '../utils/logging.js';
import { z } from 'zod';
import type { DomainTool } from './types.js';
import { returnNeedsAuthResponse } from '../../netlify/functions/mcp-server/utils.js';
import { FetchServerResponse } from 'fetch-to-node';

const listOfDomainTools = [userDomainTools, deployDomainTools, teamDomainTools, projectDomainTools, extensionDomainTools];

export const bindTools = async (server: McpServer, request?: Request) => {

  const toSelectorSchema = (domainTool: DomainTool<z.ZodType<any>>) => {
    return z.object({
      // domain: z.literal(domainTool.domain),
      operation: z.literal(domainTool.operation),
      params: domainTool.inputSchema,

      llmModelName: z.string().optional(),
      aiAgentName: z.string().optional()
    });
  }

  listOfDomainTools.map(domainTools => {

    const domain = domainTools[0].domain;

    // join the input schemas of all domain tools into a raw array with
    // to give the llm the ability to select.
    const paramsSchema = {
      // @ts-ignore
      selectSchema: domainTools.length > 1 ? z.union(domainTools.map(tool => toSelectorSchema(tool))) : toSelectorSchema(domainTools[0])
    };

    const toolName = `netlify-${domain}-services`;
    const toolDescription = `Select and run one of the following Netlify operations ${domainTools.map(tool => tool.operation).join(', ')}`;

    server.tool(toolName, toolDescription, paramsSchema, async (...args) => {
      checkCompatibility();

      try {

        await getNetlifyAccessToken(request);
      } catch (error: NetlifyUnauthError | any) {

        // rethrow error to the top level handler to catch
        // so we can update the fn request to return a proper
        // server response instead of a tool response
        if (error instanceof NetlifyUnauthError && request) {
          throw new NetlifyUnauthError();
        }

        return {
          content: [{ type: "text", text: error?.message || 'Failed to get Netlify token' }],
          isError: true
        };
      }

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

      const result = await subtool.cb(selectedSchema.params, {request});

      appendToLog(`${domain} operation result: ${JSON.stringify(result)}`);

      return {
        content: [{ type: "text", text: JSON.stringify(result) }]
      }
    });
  });
};

