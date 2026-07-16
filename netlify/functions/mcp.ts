import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toFetchResponse, toReqRes } from "fetch-to-node";
import { addCORSHeadersToFetchResp, addCommonHeadersToHandlerResp, headersToHeadersObject, returnNeedsAuthResponse } from "./mcp-server/utils.ts";
import { getContextConsumerConfig, getNetlifyCodingContext } from "../../src/context/coding-context.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getPackageVersion } from "../../src/utils/version.ts";
import { z } from "zod";
import { checkCompatibility } from "../../src/utils/compatibility.ts";
import { bindTools } from "../../src/tools/index.ts";
import { registerClaudeDesignImportTool } from "../../src/tools/design-import/import-claude-design.ts";
import { userIsAuthenticated, getTokenIdentity, UNAUTHED_ERROR_PREFIX } from "../../src/utils/api-networking.ts";
import { isClaudeMCPClient } from "../../src/utils/client-detection.ts";
import { maskToken, paramsSummary } from "./mcp-server/logging.ts";
import { log, withLogContext, addLogContext, newRequestId, initLogger } from "./mcp-server/logger.ts";
import { systemLogForwarder } from "./mcp-server/system-log-forwarder.ts";
import {Config} from "@netlify/functions";

// Route structured logs onto Netlify's system-log channel for this Node
// function. Runs once at cold start; edge/CLI keep the default console forwarder.
initLogger({ forward: systemLogForwarder });

// Netlify serverless function handler
export default async (req: Request) => {

  const url = new URL(req.url);

  // Establish the request-scoped log context up front so every line — including
  // ones emitted deep in tool/API code — carries service/requestId/version and
  // the HTTP method+path. Auth later enriches this with userId/teamId.
  return withLogContext(
    {
      service: 'mcp',
      requestId: newRequestId(),
      version: getPackageVersion(),
      httpMethod: req.method,
      path: url.pathname,
    },
    async () => {
      try {

        log.debug('mcp request', { auth: maskToken(req.headers.get('Authorization')) });

        // Handle different HTTP methods
        if (req.method === "POST") {
          return await handleMCPPost(req);
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

        log.error("MCP error", { err: error });
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
    }
  );
};


async function handleMCPPost(req: Request) {

  // Read the body once as text so we can tell an empty body (common for
  // probes/health-checks/scanners hitting the public endpoint) apart from
  // malformed/truncated JSON (which may signal a real client or proxy issue).
  const raw = await req.text();

  if (!raw.trim()) {
    // Empty POST — not a real MCP request. Respond without logging noise.
    return jsonRpcError(400, -32600, 'Request body is required');
  }

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch (error) {
    log.error('Invalid JSON in MCP POST body', {
      bytes: raw.length,
      contentType: req.headers.get('content-type'),
      userAgent: req.headers.get('user-agent'),
    });
    return jsonRpcError(400, -32700, 'Parse error: invalid JSON body');
  }

  // Fold the MCP call identity into the request context so every subsequent line
  // (auth, tool binding, response) is attributed to this JSON-RPC call.
  addLogContext({
    mcpMethod: body?.method,
    mcpId: body?.id,
    clientInfoName: body?.params?.clientInfo?.name,
  });

  // Log the SHAPE of the call only — the tool name and the names of the
  // arguments provided, never the argument VALUES. Tool arguments (and tool
  // results, see the response log below) routinely carry secrets/PII: env var
  // values, form submissions, project data. So we deliberately never log those
  // values, only their property names.
  log.debug('mcp post body', paramsSummary(body?.params));

  // Request headers relevant to StreamableHTTP/MCP negotiation. `accept` must
  // include both application/json and text/event-stream or the transport rejects
  // the request; session/protocol headers help correlate the handshake.
  log.debug('mcp post request', {
    accept: req.headers.get('accept'),
    contentType: req.headers.get('content-type'),
    mcpSessionId: req.headers.get('mcp-session-id'),
    mcpProtocolVersion: req.headers.get('mcp-protocol-version'),
    userAgent: req.headers.get('user-agent'),
    // origin/referer identify which surface a request comes from; kept for
    // diagnosing client behaviour when verbose logging is enabled.
    origin: req.headers.get('origin'),
    referer: req.headers.get('referer'),
    auth: maskToken(req.headers.get('Authorization')),
  });

  // Check for verbose mode via query parameter
  const url = new URL(req.url);
  const verboseMode = url.searchParams.get('verbose') === 'true';
  log.debug('mcp post handling', { verboseMode });

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
    // If a token was presented but failed validation, signal invalid_token so the
    // client refreshes; if none was sent, send a bare challenge to start auth.
    const tokenPresented = !!req.headers.get('authorization');
    log.debug('mcp auth failed', { tokenPresented });
    return returnNeedsAuthResponse(tokenPresented
      ? { error: 'invalid_token', errorDescription: 'The access token is invalid or expired' }
      : undefined);
  }
  // Attach the caller's identity (embedded in the JWE at auth time) to the log
  // context so every subsequent line for this request is attributed to them.
  // Null for raw PATs or pre-identity tokens — logs simply carry no user fields.
  const identity = await getTokenIdentity(req);
  if (identity) {
    addLogContext({ userId: identity.userId, teamId: identity.teamId });
  }

  log.debug('mcp request auth passed');

  // Always-on record of each tool invocation (value-free — tool name + argument
  // names only, via paramsSummary). Other JSON-RPC methods (initialize,
  // tools/list, …) stay at debug so steady-state logs aren't noisy.
  if (body?.method === 'tools/call') {
    log.info('tool call', paramsSummary(body?.params));
  }

  const server = new McpServer({
    name: "netlify",
    title: "Netlify",
    version: getPackageVersion(),
    websiteUrl: "https://www.netlify.com",
    icons: [{ src: "https://www.netlify.com/favicon/icon.svg", mimeType: "image/svg+xml" }],
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

  // Standalone top-level tool (not part of the domain selector) so Claude Design
  // can discover it by its exact name and list Netlify as a "Send to" destination.
  // Registered only for Claude clients, which keeps it out of every non-Claude
  // agent's tools/list. Within Claude it can still surface on other surfaces
  // (Claude Code, claude.ai chat) because they share the connector's MCP URL and
  // Claude does not filter tools per surface today; a per-URL marker is not an
  // option since that URL is inherited from the claude.ai connector.
  if (isClaudeMCPClient(req, body)) {
    registerClaudeDesignImportTool(server, req);
  }

  try {
    await bindTools(server, req, verboseMode);
  } catch (error: any) {

    log.error('Failed to bind tools to MCP server', { err: error });
    return new Response('Failed to bind tools to MCP server', {status: 500});
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  transport.onerror = (error) => {
    log.error("Transport error", { err: error });
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

    // Log response metadata only — status, type, and size — never the body,
    // which contains tool result values (env vars, form data, project details).
    log.debug('mcp response', {
      status: response.status,
      contentType: response.headers.get('content-type'),
      bytes: returnData.length,
    });

    if(returnData.includes(UNAUTHED_ERROR_PREFIX)){
      // A downstream Netlify call rejected the token mid-request — it's no longer
      // valid, so flag invalid_token rather than a bare challenge.
      log.error("Unauthorized error detected in response");
      return returnNeedsAuthResponse({ error: 'invalid_token', errorDescription: 'The Netlify access token is no longer valid' });
    }

  } catch (error) {
    log.error("Error parsing response JSON", { err: error });
  }

  return addCORSHeadersToFetchResp(response);
}

// Build a JSON-RPC error response so clients get a consistent, parseable shape.
function jsonRpcError(status: number, code: number, message: string) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
    {
      status,
      headers: { "Content-Type": "application/json" }
    }
  );
}

// For the stateless server, GET requests are used to initialize
// SSE connections which are stateful. Therefore, we don't need
// to handle GET requests but we can signal to the client this error.
function handleMCPGet() {
  return jsonRpcError(405, -32002, "Method not allowed.");
}

function handleMCPDelete() {
  return jsonRpcError(405, -32002, "Method not allowed.");
}


// Ensure this function responds to the <domain>/mcp path
// This can be any path you want but you'll need to ensure the
// mcp server config you use/share matches this path.
export const config: Config = {
  path: ["/mcp"],
};
