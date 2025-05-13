import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { baselineAPIContext } from './src/context/ctx.js';
import { staticCommands } from './src/context/static-commands/index.js';
import { getDynamicCommands, reduceVerboseOperationResponses } from './src/context/dynamic-commands/index.js';
import { getContextConsumerConfig, getNetlifyCodingContext } from "./src/context/coding-context.js";

const server = new McpServer({
  name: "netlify-mcp",
  version: "1.0.0"
});

const mcpSchemas = await getDynamicCommands();

const toolsGetAndCallPromptingVersion = "1.1";

// load the consumer configuration for the MCP so
// we can share all of the available context for the
// client to select from.
const contextConsumer = await getContextConsumerConfig();
const availableContextTypes = Object.keys(contextConsumer?.contextScopes || {});
const creationTypeEnum = z.enum(availableContextTypes as [string, ...string[]]);

server.tool(
  "get-netlify-coding-context",
  "ALWAYS call when writing serverless or Netlify code. required step before creating or editing any type of functions, Netlify sdk/library  usage, etc.",
  { creationType: creationTypeEnum },
  async ({creationType}: {creationType: z.infer<typeof creationTypeEnum>}) => {

    const context = await getNetlifyCodingContext(creationType);
    const text = context?.content || '';

    return ({
      content: [{type: "text", text}]
    });
  }
);


// where possible we can avoid the call-netlify-command tool but if there
// is data that the agent should aggregate first then we will use this tool to
// inform the agent what command to run and the parameters that are required.
server.tool(
  "get-netlify-command-context",
  "required step before calling 'call-netlify-command' tool. Use to identify the correct command to run and the parameters that are required.",
  {
    operationId: z.enum([
      ...staticCommands.map(c => c.operationId),
      ...Object.keys(mcpSchemas)
    ] as [string, ...string[]])
  },
  async ({ operationId }) => {

    let text = '';
    const staticCmd = staticCommands.find(c => c.operationId === operationId);
    if (staticCmd) {

      if(staticCmd.runOperation && staticCmd.runRequiresParams){
        text = await staticCmd.runOperation();
      }else {
        text = staticCmd.commandText;
      }

    } else if (mcpSchemas[operationId]){
      const apiCommand = mcpSchemas[operationId];
      text = `
For this API operation "${operationId}". It's description is:
${apiCommand.description}
--
You MUST call 'call-netlify-command' tool after compiling the correct information. The first argument should have the following structure:
{
  "_v":"${toolsGetAndCallPromptingVersion}",
  "type": "API",
  "operationId": "${apiCommand}",
  "params": ${JSON.stringify(apiCommand.parameters)}
}

--
Extra Context:
${baselineAPIContext}
      `
    }else {

      // TODO: add logging
      text = `Unknown operation: ${operationId}. Let us know if this keeps happening.`
    }

    return ({
      content: [{ type: "text", text }]
    })
  }
);

server.tool(
  "call-netlify-command",
  `
Call a Netlify API endpoint using the operation ID and parameters. You must use the following structure:
{
  "_v":"${toolsGetAndCallPromptingVersion}",
  "type": "<type>",
  "operationId": "<operationId>",
  "params": <params>
}
`,
  {
    type: z.enum(["API", "CLI"]),
    operationId: z.string(),
    params: z.record(z.any()).optional()
  },
  async ({ operationId, params = {}, type }) => {

    // TODO: Revisit as this is not the right way to handle CLI commands
    if(type === "CLI") {
      return {
        content: [{ type: "text", text: `To get the result of the command, run: "netlify api ${operationId} --data \"${params?.replaceAll("'", "\\'")}\"` }]
      }
    }

    const staticCmd = staticCommands.find(c => c.operationId === operationId);
    if (staticCmd && staticCmd.runOperation) {
      return {
        content: [{ type: "text", text: await staticCmd.runOperation(params) }],
      };
    }

    // Get the schema for this operation
    const schema = mcpSchemas[operationId];
    if (!schema) {
      return {
        content: [{ type: "text", text: `Unknown operation: ${operationId}. Ensure that get-netlify-command-context has been called first.` }],
        isError: true
      };
    }

    try {
      // Extract request information
      const { method, path, baseUrl, contentType } = schema.request;

      // Replace path parameters
      const formattedPath = path.replace(/{([^}]+)}/g, (_, name) => {
        if (!params[name]) {
          throw new Error(`Missing required path parameter: ${name}`);
        }
        return params[name];
      });

      // Construct the URL
      const url = new URL(formattedPath, baseUrl);

      // Add query parameters (for those with 'in: query')
      if (schema.request && schema.request.parameters) {
        Object.entries(schema.request.parameters).forEach(([name, info]) => {
          if (info.in === 'query' && params[name] !== undefined) {
            url.searchParams.append(name, params[name].toString());
          }
        });
      }

      // Prepare request options
      const options: {
        method: string;
        headers: Record<string, string>;
        body?: string;
      } = {
        method,
        headers: {
          'Accept': 'application/json',
          ...(process.env.NETLIFY_PERSONAL_ACCESS_TOKEN ? { 'Authorization': `Bearer ${process.env.NETLIFY_PERSONAL_ACCESS_TOKEN}` } : {}),
          ...(contentType ? { 'Content-Type': contentType } : {})
        }
      };

      // Add body for non-GET requests if there's data to send
      const bodyData: Record<string, any> = {};
      let hasBodyParams = false;

      if (schema.request && schema.request.parameters) {
        // Extract body parameters
        Object.entries(schema.request.parameters).forEach(([name, info]) => {
          if (info.in === 'body' && params[name] !== undefined) {
            bodyData[name] = params[name];
            hasBodyParams = true;
          }
        });

        // Add body content for supported methods if we have parameters
        if (hasBodyParams && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
          options.body = JSON.stringify(bodyData);
        }
      }

      try {

        // Make the actual API call using fetch
        const response = await fetch(url.toString(), options);

        // Parse the response
        let responseData: any;
        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('application/json')) {
          responseData = await response.json();
        } else {
          responseData = await response.text();
        }

        // Check if the request was successful
        if (!response.ok) {
          return {
            content: [{
              type: "text",
              text: `API Request Failed (${response.status} ${response.statusText}):
- Operation: ${operationId}
- URL: ${url}
- Response: ${JSON.stringify(responseData, null, 2)}`
            }],
            isError: true
          };
        }

        // For successful responses, format based on content type
        if (contentType.includes('application/json')) {

          let reducedResponse = responseData;
          if (mcpSchemas[operationId]){
            reducedResponse = reduceVerboseOperationResponses(operationId, mcpSchemas[operationId], responseData);
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify(reducedResponse)
            }]
          };
        } else {
          return {
            content: [{
              type: "text",
            text: `API Request Successful (${response.status} ${response.statusText}):
- Operation: ${operationId}
- Response Data:
${JSON.stringify(responseData, null, 2)}`
            }]
          };
        }
      } catch (fetchError: any) {
        return {
          content: [{
            type: "text",
            text: `Error making API request: ${fetchError?.message || String(fetchError)}
- Operation: ${operationId}
- URL: ${url}
- Method: ${method}`
          }],
          isError: true
        };
      }
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error preparing API request: ${error?.message || String(error)}` }],
        isError: true
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
