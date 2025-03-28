import { Config, Context} from "@netlify/edge-functions";
import { McpServer } from "https://esm.sh/@modelcontextprotocol/sdk@1.7.0/dist/esm/server/mcp.js"
import { SSEStandardTransport } from "../SSEStandardTransport.ts"
import { z } from "https://esm.sh/zod@3.21.4";

const server = new McpServer({
  name: "example-server",
  version: "1.0.0"
});

server.tool("add",
  { a: z.number(), b: z.number() },
  async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }]
  })
);


let transport: SSEStandardTransport;

export default async (req: Request, context: Context) => {
  console.log('EF called', req.url, req.method);

  const parsedUrl = new URL(req.url);



  if(req.method === "GET" && parsedUrl.pathname === "/sse"){
    console.log('upgrade to SSE')
    transport = new SSEStandardTransport("/messages");
    transport.onclose = () => {
      console.log('SSE connection closed');
    };
    transport.onerror = (error) => {
      console.error('SSE connection error:', error);
    };
    transport.onmessage = (message) => {
      console.log('SSE message:', message);
    };
    await server.connect(transport);
    return transport.response;
  }

  if(req.method === "POST" && parsedUrl.pathname === "/messages"){
    return await transport.handlePostMessage(req, new Response());
  }

  return new Response("Not Found", { status: 404 });
};

export const config: Config = {
  path: ["/mcp", "/sse", "/messages"],
  method: ["GET", "POST"]
};
