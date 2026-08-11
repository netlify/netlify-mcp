// Netlify MCP server on the MCP TypeScript SDK v2 (@modelcontextprotocol/server).
// createMcpHandler serves BOTH 2026-07-28 (modern) and 2025-era (legacy) traffic
// from one web-standard (Request)=>Response handler — replacing v1's
// StreamableHTTPServerTransport + fetch-to-node bridge.
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { addCORSHeadersToFetchResp, returnNeedsAuthResponse } from "./mcp-server/utils.ts";
import { getContextConsumerConfig, getNetlifyCodingContext } from "../../src/context/coding-context.ts";
import { getPackageVersion } from "../../src/utils/version.ts";
import { checkCompatibility } from "../../src/utils/compatibility.ts";
import { bindTools } from "../../src/tools/index.ts";
import { registerClaudeDesignImportTool } from "../../src/tools/design-import/import-claude-design.ts";
import { userIsAuthenticated, getTokenIdentity } from "../../src/utils/api-networking.ts";
import { isClaudeMCPClient } from "../../src/utils/client-detection.ts";
import { maskToken, paramsSummary } from "./mcp-server/logging.ts";
import { log, withLogContext, addLogContext, getRequestId, initLogger, getDeployId } from "./mcp-server/logger.ts";
import { withRequestSignals, getAuthChallenge } from "./mcp-server/request-signals.ts";
import { systemLogForwarder } from "./mcp-server/system-log-forwarder.ts";
import {Config, Context} from "@netlify/functions";

// Route structured logs onto Netlify's system-log channel for this Node
// function. Runs once at cold start; edge/CLI keep the default console forwarder.
initLogger({ forward: systemLogForwarder });

// Netlify serverless function handler
export default async (req: Request, context: Context) => {

  const url = new URL(req.url);

  // Establish the request-scoped log context up front so every line — including
  // ones emitted deep in tool/API code — carries service/requestId/deployId and
  // the HTTP method+path. Auth later enriches this with userId/teamId.
  return withLogContext(
    {
      service: 'mcp',
      requestId: getRequestId(req.headers),
      deployId: getDeployId(context),
      httpMethod: req.method,
      path: url.pathname,
      userAgent: req.headers.get('user-agent') ?? undefined,
      mcpProtocolVersion: req.headers.get('mcp-protocol-version') ?? undefined,
    },
    // Open a request-signals scope around the whole request so tool/API code can
    // flag an auth challenge (see request-signals.ts) that handleMCPPost reads
    // back after the MCP SDK has produced its response.
    () => withRequestSignals(async () => {
      try {

        log.debug('mcp request', { auth: maskToken(req.headers.get('Authorization')) });

        if (req.method === "POST") {
          return await handleMCPPost(req);
        } else if (req.method === "GET") {
          return await handleMCPGet(req);
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
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    })
  );
};


async function handleMCPPost(req: Request) {

  // Read the body once as text so we can tell an empty body (probes/scanners)
  // apart from malformed/truncated JSON.
  const raw = await req.text();

  if (!raw.trim()) {
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
  // is attributed to this JSON-RPC call. The `initialize` request additionally
  // carries the version the client is REQUESTING (params.protocolVersion) — the
  // mcp-protocol-version HEADER is absent on init and only reports the negotiated
  // version on later requests, so the body is the only place the requested
  // version appears. Client title and the NAMES of declared capabilities are
  // safe, value-free shape; capabilities on non-init requests are undefined and
  // simply omitted from the log line.
  const clientCapabilities = body?.params?.capabilities;
  addLogContext({
    mcpMethod: body?.method,
    mcpId: body?.id,
    clientInfoName: body?.params?.clientInfo?.name,
    clientInfoVersion: body?.params?.clientInfo?.version,
    clientInfoTitle: body?.params?.clientInfo?.title,
    mcpProtocolVersionRequested: body?.params?.protocolVersion,
    clientCapabilities:
      clientCapabilities && typeof clientCapabilities === 'object'
        ? Object.keys(clientCapabilities)
        : undefined,
  });

  // Log the SHAPE of the call only — tool name + argument names, never values.
  log.debug('mcp post body', paramsSummary(body?.params));

  log.debug('mcp post request', {
    accept: req.headers.get('accept'),
    contentType: req.headers.get('content-type'),
    mcpSessionId: req.headers.get('mcp-session-id'),
    origin: req.headers.get('origin'),
    referer: req.headers.get('referer'),
    auth: maskToken(req.headers.get('Authorization')),
  });

  // Always auth-check (including init) — the MCP spec is inconsistent on when
  // 401s may be returned.
  if(!await userIsAuthenticated(req)){
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
    // Standalone tools (coding-context, design import) have no selectSchema.operation;
    // fall back to the tool name so every call has one `operation` dimension for tracking.
    const toolName = body?.params?.name;
    const selectedOperation = body?.params?.arguments?.selectSchema?.operation;
    const operation = typeof selectedOperation === 'string' ? selectedOperation : toolName;
    addLogContext({
      toolName,
      ...(typeof operation === 'string' ? { operation } : {}),
    });
    log.info('tool call', paramsSummary(body?.params));
  } else if (body?.method === 'tools/list') {
    log.info('tools list requested');
  }

  const verboseMode = new URL(req.url).searchParams.get('verbose') === 'true';

  // Reconstruct a request with the buffered body so the v2 handler can read it
  // (req's stream was consumed above).
  const reqWithBody = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: JSON.stringify(body),
  });

  // Build the MCP server for THIS request. The factory closes over the request +
  // parsed body so tools read the token (getNetlifyAccessToken) and client
  // detection behave exactly as on v1. createMcpHandler serves whichever protocol
  // era the client speaks (legacy=2025 | modern=2026-07-28) from this one handler.
  const handler = createMcpHandler(
    async () => {
      const server = new McpServer({ name: "netlify", version: getPackageVersion() });

      const contextConsumer = await getContextConsumerConfig();
      const availableContextTypes = Object.keys(contextConsumer?.contextScopes || {});

      // Only register the coding-context tool when we actually have scopes to
      // offer. With no scopes (e.g. the consumer config failed to fetch at cold
      // start), z.enum([]) yields an uncallable tool — its required creationType
      // can satisfy no value — so skip it until scopes become available. Normal
      // enum construction proceeds whenever at least one scope exists.
      if (availableContextTypes.length > 0) {
        const creationTypeEnum = z.enum(availableContextTypes as [string, ...string[]]);

        server.registerTool(
          "get-netlify-coding-context",
          {
            description:
              "ALWAYS call when writing code. Required step before creating or editing any type of functions, Netlify sdk/library usage, etc. Use other operations for project management.",
            inputSchema: { creationType: creationTypeEnum },
            annotations: { readOnlyHint: true },
          },
          async ({ creationType }) => {
            checkCompatibility();
            const context = await getNetlifyCodingContext(creationType);
            return { content: [{ type: "text" as const, text: context?.content || "" }] };
          },
        );
      }

      // Claude-only top-level design-import tool (detected from the request/body).
      if (isClaudeMCPClient(req, body)) {
        registerClaudeDesignImportTool(server, req);
      }

      // All Netlify domain tools. A failure here shouldn't sink the whole request
      // (coding-context still works), so log and continue.
      try {
        await bindTools(server, req, verboseMode);
      } catch (error) {
        log.error('Failed to bind domain tools', { err: error });
      }

      return server;
    },
    { onerror: (error: Error) => log.error("mcp handler error", { err: error }) },
  );

  const response = await handler.fetch(reqWithBody);

  // If any authenticated Netlify API call returned 401 during tool execution, the
  // SDK has already turned that into a normal 200 tool result — so we translate
  // it back into a real OAuth challenge here, driven by the flag that
  // authenticatedFetch set (see request-signals.ts), not by inspecting the body.
  const authChallenge = getAuthChallenge();
  if (authChallenge) {
    log.warn('netlify api returned 401 during tool execution; issuing auth challenge');
    return returnNeedsAuthResponse({
      error: 'invalid_token',
      errorDescription: authChallenge.errorDescription ?? 'The Netlify access token is no longer valid',
    });
  }

  // Log response metadata only — never the body (tool result values).
  log.debug('mcp response', {
    status: response.status,
    contentType: response.headers.get('content-type'),
  });

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
    { status, headers: { "Content-Type": "application/json" } }
  );
}

// GET on the MCP endpoint. 2026-spec clients (e.g. Codex/rmcp, openai/codex#35720)
// do "GET-first" OAuth discovery: an UNAUTHENTICATED GET expecting a 401 whose
// WWW-Authenticate points at the protected-resource metadata (RFC 9728) — without
// starting an MCP session. Answer that challenge so discovery works; a 405 here
// (the old behavior) leaves those clients unable to find the auth server and they
// fail to connect. We don't support server->client SSE streams, so an
// authenticated GET has nothing to stream → 405.
async function handleMCPGet(req: Request) {
  if (!await userIsAuthenticated(req)) {
    return returnNeedsAuthResponse();
  }
  return jsonRpcError(405, -32002, "Method not allowed.");
}

function handleMCPDelete() {
  return jsonRpcError(405, -32002, "Method not allowed.");
}


// Ensure this function responds to the <domain>/mcp path
export const config: Config = {
  path: ["/mcp"],
};
