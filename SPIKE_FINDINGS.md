# MCP TypeScript SDK v2 migration (2026-07-28 protocol support)

Branch: `spike/mcp-sdk-v2`. Base: `main` (structured-logging work).
Status: **full migration complete & typecheck/test-clean** on the beta SDK. Still beta — verify on a real deploy and re-pin at GA before merging.

## Done
- Upgraded the project to **zod v4** (`zod@^4.2.0`, resolves to 4.4.3; deduped with the SDK's zod).
- Removed **v1** `@modelcontextprotocol/sdk`; added **v2** `@modelcontextprotocol/server` + `@modelcontextprotocol/core` (`2.0.0-beta.4`, exact-pinned).
- `netlify/functions/mcp.ts`: v1 transport + `fetch-to-node` → **v2 `createMcpHandler`** (web-standard `.fetch`). Per-request factory registers the **full toolset**: `get-netlify-coding-context` (schema restored), the Claude design-import tool, and all domain tools via `bindTools`.
- `src/tools/index.ts`, `src/tools/types.ts`, `src/tools/design-import/import-claude-design.ts`: `McpServer`/`ToolAnnotations` re-sourced from `@modelcontextprotocol/server`. The 24 domain-tool schema files needed **no changes** (their zod usage is v3/v4-compatible).
- `netlify-mcp.ts` (CLI): v1 `StdioServerTransport` → **v2 `serveStdio`**.
- Added `mcp server built` (era, verboseMode, domainToolsRegistered) + `tools list requested` logging.

## Verified
- `tsc --noEmit` clean; `npm test` 31/31.
- One `createMcpHandler` serves **both** `2026-07-28` (modern, with `_meta` envelope) and `2025-11-25` (legacy) → both `200`. The original `Unsupported protocol version` error is gone.
- zod v4 union/object schemas (the `bindTools` selector pattern) register and serialize into `tools/list` at runtime.

## Remaining before merge
1. **Deploy to a real Netlify environment** and test a live `2026-07-28` client + a `2025` client end-to-end through OAuth (local smoke only so far).
2. **`_meta` client info**: `2026-07-28` moves `clientInfo` into per-request `_meta` (keys `io.modelcontextprotocol/clientInfo` etc.), not the initialize body. Update `client-detection.ts` (design-import gating) and the `clientInfoName`/`clientInfoVersion` logging to read `_meta` — today they fall back to user-agent for modern clients.
3. **Re-pin off `-beta.4`** to GA `2.0.0` when it ships (with the spec, 2026-07-28).
4. Optional: hoist `createMcpHandler` to module scope (currently per-request) using `ctx.requestInfo`, once the `_meta` path removes the need to close over the parsed body.
5. Remove now-unused `fetch-to-node` dependency.

## Notes
- `oauth-server.ts` and the edge `proxy.ts`/`request-logger.ts` were untouched — they don't use the MCP transport SDK.
- Handler is built per request (closes over the parsed body for client-detection + token access), matching v1 behavior; fine for a stateless function.
