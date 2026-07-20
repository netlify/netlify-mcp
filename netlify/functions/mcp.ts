// SPIKE: migrated to the MCP TypeScript SDK v2 (@modelcontextprotocol/server,
// 2.0.0-beta.4) to support the 2026-07-28 protocol. v2's createMcpHandler serves
// BOTH 2026-07-28 (modern) and 2025-era (legacy) traffic from one web-standard
// (Request)=>Response handler — replacing v1's StreamableHTTPServerTransport +
// fetch-to-node bridge.
//
// DEFERRED (not in this spike): bindTools (all domain tools) and the Claude
// design-import tool. Those register schemas built with zod v3, but v2's
// registerTool types against `zod/v4`. Migrating them is the remaining lift —
// see SPIKE note below. Only get-netlify-coding-context is wired here to prove
// the transport + dual-era serving end to end.
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { addCORSHeadersToFetchResp, returnNeedsAuthResponse } from "./mcp-server/utils.ts";
import { getContextConsumerConfig, getNetlifyCodingContext } from "../../src/context/coding-context.ts";
import { getPackageVersion } from "../../src/utils/version.ts";
import { checkCompatibility } from "../../src/utils/compatibility.ts";
import { userIsAuthenticated, getTokenIdentity, UNAUTHED_ERROR_PREFIX } from "../../src/utils/api-networking.ts";
import { maskToken, paramsSummary } from "./mcp-server/logging.ts";
import { log, withLogContext, addLogContext, newRequestId, initLogger, getDeployId } from "./mcp-server/logger.ts";
import { systemLogForwarder } from "./mcp-server/system-log-forwarder.ts";
import {Config, Context} from "@netlify/functions";

// Route structured logs onto Netlify's system-log channel for this Node
// function. Runs once at cold start; edge/CLI keep the default console forwarder.
initLogger({ forward: systemLogForwarder });

// The v2 handler is created once. Its factory runs per request and returns a
// fresh McpServer; `era` (legacy|modern) lets the same handler serve both
// protocol revisions. Auth is pass-through — we gate in front and the tools
// read the token from the request themselves (unchanged from v1).
const mcpHandler = createMcpHandler(
  async (ctx) => {
    const server = new McpServer({
      name: "netlify",
      version: getPackageVersion(),
    });
    const registeredTools: string[] = [];

    const contextConsumer = await getContextConsumerConfig();
    const availableContextTypes = Object.keys(contextConsumer?.contextScopes || {});

    // SPIKE: registered WITHOUT an inputSchema. The real tool takes a
    // `creationType` enum built with zod v3, but v2's registerTool types
    // inputSchema against zod v4 (the SDK depends on zod@^4.2.0; the project is
    // on zod@3.25.76). Proving the transport here; the schema'd registration
    // returns once the project moves to zod v4 (same lift as bindTools).
    server.registerTool(
      "get-netlify-coding-context",
      {
        description:
          "ALWAYS call when writing code. Required step before creating or editing any type of functions, Netlify sdk/library usage, etc. Use other operations for project management.",
        annotations: { readOnlyHint: true },
      },
      async () => {
        checkCompatibility();
        const context = await getNetlifyCodingContext(availableContextTypes[0]);
        return { content: [{ type: "text" as const, text: context?.content || "" }] };
      },
    );
    registeredTools.push("get-netlify-coding-context");

    // SPIKE TODO: register the domain tools + Claude design-import here once
    // their zod v3 schemas are migrated to zod/v4 (v2's registerTool types
    // inputSchema against zod/v4). Today `bindTools(server, req, verboseMode)`
    // and `registerClaudeDesignImportTool(server, req)` would not type-check
    // against the v2 McpServer.

    // Visibility in the function logs: which protocol era this request is served
    // as, and EXACTLY which tools are exposed. On this spike branch only the
    // coding-context tool is registered — the domain tools (bindTools) and
    // design-import are deferred pending the zod v4 migration, which is why
    // clients currently see nothing else. This makes that explicit per request.
    log.info('mcp server built', {
      era: ctx.era,
      toolCount: registeredTools.length,
      tools: registeredTools,
      domainToolsRegistered: false,
    });

    return server;
  },
  { onerror: (error: Error) => log.error("mcp handler error", { err: error }) },
);

// Netlify serverless function handler
export default async (req: Request, context: Context) => {

  const url = new URL(req.url);

  // Establish the request-scoped log context up front so every line — including
  // ones emitted deep in tool/API code — carries service/requestId/deployId and
  // the HTTP method+path. Auth later enriches this with userId/teamId.
  return withLogContext(
    {
      service: 'mcp',
      requestId: newRequestId(),
      deployId: getDeployId(context),
      httpMethod: req.method,
      path: url.pathname,
      userAgent: req.headers.get('user-agent') ?? undefined,
      mcpProtocolVersion: req.headers.get('mcp-protocol-version') ?? undefined,
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
    });
    return jsonRpcError(400, -32700, 'Parse error: invalid JSON body');
  }

  // Fold the MCP call identity into the request context so every subsequent line
  // (auth, tool binding, response) is attributed to this JSON-RPC call.
  addLogContext({
    mcpMethod: body?.method,
    mcpId: body?.id,
    clientInfoName: body?.params?.clientInfo?.name,
    clientInfoVersion: body?.params?.clientInfo?.version,
  });

  // Log the SHAPE of the call only — the tool name and the names of the
  // arguments provided, never the argument VALUES.
  log.debug('mcp post body', paramsSummary(body?.params));

  log.debug('mcp post request', {
    accept: req.headers.get('accept'),
    contentType: req.headers.get('content-type'),
    mcpSessionId: req.headers.get('mcp-session-id'),
    origin: req.headers.get('origin'),
    referer: req.headers.get('referer'),
    auth: maskToken(req.headers.get('Authorization')),
  });

  // Right now, the MCP spec is inconsistent on _when_ 401s can be returned. So
  // we always do the auth check, including for init.
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
  const identity = await getTokenIdentity(req);
  if (identity) {
    addLogContext({ userId: identity.userId, teamId: identity.teamId });
  }

  log.debug('mcp request auth passed');

  if (body?.method === 'tools/call') {
    addLogContext({ toolName: body?.params?.name });
    log.info('tool call', paramsSummary(body?.params));
  } else if (body?.method === 'tools/list') {
    // Tool discovery — pair this with the 'mcp server built' line (which reports
    // toolCount/tools) to see exactly what a client is offered.
    log.info('tools list requested');
  }

  // Reconstruct a request with the buffered body so the v2 handler can read it
  // (we already consumed req's stream above). v2's fetch is web-standard, so no
  // Node req/res bridge is needed.
  const reqWithBody = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: JSON.stringify(body),
  });

  const response = await mcpHandler.fetch(reqWithBody);

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

// Stateless server: GET/DELETE (2025 session operations) aren't supported.
function handleMCPGet() {
  return jsonRpcError(405, -32002, "Method not allowed.");
}

function handleMCPDelete() {
  return jsonRpcError(405, -32002, "Method not allowed.");
}


// Ensure this function responds to the <domain>/mcp path
export const config: Config = {
  path: ["/mcp"],
};
