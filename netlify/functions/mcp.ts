import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toFetchResponse, toReqRes } from "fetch-to-node";
import { addCORSHeadersToFetchResp, addCommonHeadersToHandlerResp, headersToHeadersObject, returnNeedsAuthResponse } from "./mcp-server/utils.ts";
import { getContextConsumerConfig, getNetlifyCodingContext } from "../../src/context/coding-context.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getPackageVersion } from "../../src/utils/version.ts";
import { z } from "zod";
import { checkCompatibility } from "../../src/utils/compatibility.ts";
import { bindTools } from "../../src/tools/index.ts";
import { userIsAuthenticated, UNAUTHED_ERROR_PREFIX } from "../../src/utils/api-networking.ts";
import {Config} from "@netlify/functions";

// Netlify serverless function handler
export default async (req: Request) => {

  try {

    // masked headers
    console.log('mcp', {
      reqMethod: req.method, 
      url: req.url,
      auth: (req.headers.get('Authorization') || '').slice(0, 40) + '...'
    });

    // Handle different HTTP methods
    if (req.method === "POST") {
      return handleMCPPost(req);
    } else if (req.method === "GET") {
      return handleMCPGet();
    } else if (req.method === "DELETE") {
      return handleMCPDelete();
    } else if (req.method === "OPTIONS") { 
      return new Response('', {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "*",
          "Access-Control-Allow-Headers": "*"
        }
      });
    } else {
      return new Response("Method not allowed", { status: 405 });
    }

  } catch (error) {

    console.error("MCP error:", error);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
};


async function handleMCPPost(req: Request) {

  // Read body once and reuse it
  let body: any;
  try {
    body = await req.json();
    console.log('Handling MCP POST request', {
      body: JSON.stringify(body, null, 2),
    });
  } catch (error) {
    console.error('Error reading request body:', error);
    return new Response('Invalid JSON body', {status: 400});
  }

  // Check for verbose mode via query parameter
  const url = new URL(req.url);
  const verboseMode = url.searchParams.get('verbose') === 'true';
  if (verboseMode) {
    console.log('Verbose mode enabled - tools will be registered individually');
  }

  // Create a new Request with the body as a string to avoid re-reading issues
  // toReqRes will try to read the body, so we need to provide a fresh request
  const reqWithBody = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: JSON.stringify(body),
  });

  // Convert the Request object into a Node.js Request object
  const { req: nodeReq, res: nodeRes } = toReqRes(reqWithBody);

  // Right now, the MCP spec is inconcistent on _when_ 
  // 401s can be returned. So, we will always do the auth
  // check, including for init.
  if(!await userIsAuthenticated(req)){
    return returnNeedsAuthResponse();
  }

  const server = new McpServer({
    name: "netlify",
    version: getPackageVersion(),
  });

  const contextConsumer = await getContextConsumerConfig();
  const availableContextTypes = Object.keys(contextConsumer?.contextScopes || {});
  const creationTypeEnum = z.enum(availableContextTypes as [string, ...string[]]);
  
  server.tool(
    "get-netlify-coding-context",
    "ALWAYS call when writing code. Required step before creating or editing any type of functions, Netlify sdk/library  usage, etc. Use other operations for project management.",
    { creationType: creationTypeEnum },
    async ({creationType}: {creationType: z.infer<typeof creationTypeEnum>}) => {
  
      checkCompatibility();
  
      const context = await getNetlifyCodingContext(creationType);
      const text = context?.content || '';
  
      return ({
        content: [{type: "text", text}]
      });
    }
  );

  try {
    await bindTools(server, req, verboseMode);
  } catch (error: any) {

    console.error('Failed to bind tools to MCP server:', error);
    return new Response('Failed to bind tools to MCP server', {status: 500});
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  transport.onerror = (error) => {
    console.error("Transport error:", error);
  };

  await server.connect(transport);

  await transport.handleRequest(nodeReq, nodeRes, body);

  nodeRes.on("close", () => {
    transport.close();
    server.close();
  });

  const response = await toFetchResponse(nodeRes);
  try {
    const returnData = await response.clone().text();

    if(returnData.includes(UNAUTHED_ERROR_PREFIX)){
      console.error("Unauthorized error detected in response:", returnData);
      return returnNeedsAuthResponse();
    }

  } catch (error) {
    console.error("Error parsing response JSON:", error);
  }

  return addCORSHeadersToFetchResp(response);
}

// For the stateless server, GET requests are used to initialize
// SSE connections which are stateful. Therefore, we don't need
// to handle GET requests but we can signal to the client this error.
function handleMCPGet() {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32002,
        message: "Method not allowed.",
      },
      id: null,
    }),
    {
      status: 405,
      headers: { "Content-Type": "application/json" }
    }
  );
}

function handleMCPDelete() {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32002,
        message: "Method not allowed.",
      },
      id: null,
    }),
    {
      status: 405,
      headers: { "Content-Type": "application/json" }
    }
  );
}


// Ensure this function responds to the <domain>/mcp path
// This can be any path you want but you'll need to ensure the
// mcp server config you use/share matches this path.
export const config: Config = {
  path: ["/mcp"],
};
