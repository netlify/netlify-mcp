import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toFetchResponse, toReqRes } from "fetch-to-node";
import { headersToHeadersObject, returnNeedsAuthResponse } from "./mcp-server/utils.js";
import { getContextConsumerConfig, getNetlifyCodingContext } from "../../src/context/coding-context.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getPackageVersion } from "../../src/utils/version.js";
import { z } from "zod";
import { checkCompatibility } from "../../src/utils/compatibility.js";
import { bindTools } from "../../src/tools/index.js";
import { userIsAuthenticated, UNAUTHED_ERROR_PREFIX } from "../../src/utils/api-networking.js";

// Netlify serverless function handler
export default async (req: Request) => {

  try {

    console.log('mcp', {reqMethod: req.method, url: req.url, headers: Object.fromEntries(req.headers.entries())});

    // Handle different HTTP methods
    if (req.method === "POST") {
      return handleMCPPost(req);
    } else if (req.method === "GET") {
      return handleMCPGet();
    } else if (req.method === "DELETE") {
      return handleMCPDelete();
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

  // Convert the Request object into a Node.js Request object
  const { req: nodeReq, res: nodeRes } = toReqRes(req);
  
  try {
    console.log('Handling MCP POST request', {
      body: JSON.stringify(await (await req.clone()).json(), null, 2),
      headers: headersToHeadersObject(req.headers),
    });
  } catch (error) {
    console.error('Error reading request body:', error);
  }

  // TBD if needed.
  // if(!await userIsAuthenticated(req)){
  //   return returnNeedsAuthResponse();
  // }

  const server = new McpServer({
    name: "netlify-mcp",
    version: getPackageVersion(),
  });

  const contextConsumer = await getContextConsumerConfig();
  const availableContextTypes = Object.keys(contextConsumer?.contextScopes || {});
  const creationTypeEnum = z.enum(availableContextTypes as [string, ...string[]]);
  
  server.tool(
    "get-netlify-coding-context",
    "ALWAYS call when writing serverless or Netlify code. required step before creating or editing any type of functions, Netlify sdk/library  usage, etc.",
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
    await bindTools(server, req);
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

  const body = await req.json();
  await transport.handleRequest(nodeReq, nodeRes, body);

  nodeRes.on("close", () => {
    transport.close();
    server.close();
  });

  const response = await toFetchResponse(nodeRes);
  try {
    const returnData = await (await response.clone()).text();

    if(returnData.includes(UNAUTHED_ERROR_PREFIX)){
      console.error("Unauthorized error detected in response:", returnData);
      return returnNeedsAuthResponse();
    }

  } catch (error) {
    console.error("Error parsing response JSON:", error);
  }

  return response;
}

// For the stateless server, GET requests are used to initialize
// SSE connections which are stateful. Therefore, we don't need
// to handle GET requests but we can signal to the client this error.
function handleMCPGet() {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
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
        code: -32000,
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
export const config = {
  path: "/mcp"
};
