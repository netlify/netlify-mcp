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
import { categorizeToolsByReadWrite } from './tool-utils.js';
import { z } from 'zod';
import type { DomainTool } from './types.js';

const listOfDomainTools = [userDomainTools, deployDomainTools, teamDomainTools, projectDomainTools, extensionDomainTools];

const toSelectorSchema = (domainTool: DomainTool<any>) => {
  return z.object({
    // domain: z.literal(domainTool.domain),
    operation: z.literal(domainTool.operation),
    params: domainTool.inputSchema,

    llmModelName: z.string().optional(),
    aiAgentName: z.string().optional()
  });
}

export const bindTools = async (server: McpServer, remoteMCPRequest?: Request, verboseMode: boolean = false) => {

  const isRemoteMCP = !!remoteMCPRequest;

  listOfDomainTools.forEach(domainTools => {
    
    const domain = domainTools[0].domain;
    const filteredDomainTools = domainTools.filter(tool => {
      if(isRemoteMCP && tool.omitFromRemoteMCP) {
        return false;
      }
      if(!isRemoteMCP && tool.omitFromLocalMCP) {
        return false;
      }
      return true;
    });

    // Categorize tools into read-only and write operations
    const { readOnlyTools, writeTools } = categorizeToolsByReadWrite(filteredDomainTools);

    // Register read-only tools if any exist
    if (readOnlyTools.length > 0) {
      registerDomainTools(server, readOnlyTools, domain, 'read', remoteMCPRequest, verboseMode);
    }

    // Register write tools if any exist
    if (writeTools.length > 0) {
      registerDomainTools(server, writeTools, domain, 'write', remoteMCPRequest, verboseMode);
    }
  });
};

const registerDomainTools = (
  server: McpServer, 
  tools: DomainTool<any>[], 
  domain: string, 
  operationType: 'read' | 'write',
  remoteMCPRequest?: Request,
  verboseMode: boolean = false
) => {
  const toolOperations = tools.map(tool => tool.operation);
  const readOnlyIndicator = operationType === 'read' ? ' (read-only)' : '';

  if (verboseMode) {
    // Register each tool individually (no anyOf/union)
    tools.forEach(tool => {
      const toolName = `netlify-${domain}-${tool.operation}`;
      const toolDescription = `${tool.operation} operation for Netlify ${domain}${readOnlyIndicator}`;

      // The MCP SDK expects inputSchema to be a plain object with Zod schemas as properties
      // We need to extract the shape from the Zod object and use it directly
      const schemaShape = tool.inputSchema.shape || {};

      server.registerTool(toolName, {
        description: toolDescription,
        inputSchema: schemaShape,
        annotations: {
          readOnlyHint: operationType === 'read'
        }
      }, async (...args) => {
        checkCompatibility();

        try {
          await getNetlifyAccessToken(remoteMCPRequest);
        } catch (error: NetlifyUnauthError | any) {
          if (error instanceof NetlifyUnauthError && remoteMCPRequest) {
            throw new NetlifyUnauthError();
          }

          return {
            content: [{ type: "text", text: error?.message || 'Failed to get Netlify token' }],
            isError: true
          };
        }

        appendToLog(`${toolName} operation: ${JSON.stringify(args)}`);

        const result = await tool.cb(args[0], {request: remoteMCPRequest, isRemoteMCP: !!remoteMCPRequest});

        appendToLog(`${domain} operation result: ${JSON.stringify(result)}`);

        return {
          content: [{ type: "text", text: JSON.stringify(result) }]
        }
      });
    });
  } else {
    // Register tools grouped by domain with selector (uses anyOf/union)
    const paramsSchema = {
      // @ts-ignore
      selectSchema: tools.length > 1 ? z.union(tools.map(tool => toSelectorSchema(tool))) : toSelectorSchema(tools[0])
    };

    const friendlyOperationType = operationType === 'read' ? 'reader' : 'updater';
    const toolName = `netlify-${domain}-services-${friendlyOperationType}`;
    const toolDescription = `Select and run one of the following Netlify ${operationType} operations${readOnlyIndicator} ${toolOperations.join(', ')}`;

    server.registerTool(toolName, {
      description: toolDescription,
      inputSchema: paramsSchema,
      annotations: {
        readOnlyHint: operationType === 'read'
      }
    }, async (...args) => {
      checkCompatibility();

      try {
        await getNetlifyAccessToken(remoteMCPRequest);
      } catch (error: NetlifyUnauthError | any) {
        if (error instanceof NetlifyUnauthError && remoteMCPRequest) {
          throw new NetlifyUnauthError();
        }

        return {
          content: [{ type: "text", text: error?.message || 'Failed to get Netlify token' }],
          isError: true
        };
      }

      appendToLog(`${toolName} operation: ${JSON.stringify(args)}`);

      const selectedSchema = args[0]?.selectSchema as any;

      if (!selectedSchema) {
        return {
          content: [{ type: "text", text: 'Failed to select a valid operation. Retry the MCP operation but select the operation and provide the right inputs.' }]
        }
      }

      const operation = selectedSchema.operation;

      const subtool = tools.find(subtool => subtool.operation === operation);

      if (!subtool) {
        return {
          content: [{ type: "text", text: 'Agent called the wrong MCP tool for this operation.' }]
        }
      }

      const result = await subtool.cb(selectedSchema.params, {request: remoteMCPRequest, isRemoteMCP: !!remoteMCPRequest});

      appendToLog(`${domain} operation result: ${JSON.stringify(result)}`);

      return {
        content: [{ type: "text", text: JSON.stringify(result) }]
      }
    });
  }
};

