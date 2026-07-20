# Spike: MCP TypeScript SDK v2 (2026-07-28 protocol support)

Branch: `spike/mcp-sdk-v2` — **do not merge as-is** (beta SDK, partial migration).
Base: `main` @ `aa39e8d` (all the structured-logging work).

## Goal
Confirm the Netlify MCP can support the new `2026-07-28` protocol (the RC that
triggered `Unsupported protocol version` on our v1 SDK) **and** keep serving
2025-era clients, by trialing the v2 SDK beta.

## What was done
- Added `@modelcontextprotocol/server@2.0.0-beta.4` + `@modelcontextprotocol/core@2.0.0-beta.4` (exact pins). Kept `@modelcontextprotocol/sdk@^1.29.0` (CLI + tools still use it).
- Migrated `netlify/functions/mcp.ts` from v1 (`McpServer` + `StreamableHTTPServerTransport` + `fetch-to-node`) to v2 `createMcpHandler` + web-standard `.fetch`.
- Kept all our custom wiring intact: structured logging + request context, the pre-handler auth gate (`userIsAuthenticated` → `returnNeedsAuthResponse`), identity enrichment, CORS, the `UNAUTHED_ERROR_PREFIX` re-check.

## Proven (smoke-tested against the v2 handler)
- **Legacy `2025-11-25`**: `initialize` and `tools/list` → `200`, correct results.
- **Modern `2026-07-28`**: with the required per-request `_meta` envelope → `200`, tool list returned (new modern fields `resultType`/`ttlMs`/`cacheScope`). Crucially, `2026-07-28` is **recognized**, not the `Unsupported protocol version` 400 we get on v1.
- **One `createMcpHandler` serves both eras** (default `legacy: 'stateless'`).
- Web-standard `(Request) => Response` fits Netlify Functions directly — `fetch-to-node` bridge removed.
- `tsc --noEmit` clean.

## The blocker for a full migration: zod v3 → v4
- v2 SDK depends on **`zod@^4.2.0`**; this project is on **`zod@3.25.76`** (v3).
- v2's `registerTool` types `inputSchema` against zod v4. Registering a zod v3
  schema fails typecheck (`ZodEnum … missing toJSONSchema/encode/decode/…`).
- So in this spike `get-netlify-coding-context` is registered **without** an
  input schema, and `bindTools` + the Claude design-import tool are **not wired
  yet** (they build zod v3 schemas).

## Remaining work for a real migration
1. **Upgrade the project to zod v4** (breaking; touches every tool's schema). This is the bulk of the effort.
2. **Migrate `bindTools`** (`src/tools/index.ts`) and all domain tools to the v2 `registerTool` + zod v4 API. The `npx @modelcontextprotocol/codemod@beta v1-to-v2 .` codemod automates much of the `.tool()`→`registerTool()` renames.
3. **Re-wire the Claude design-import tool** (`registerClaudeDesignImportTool`).
4. **client-detection**: 2026-07-28 puts `clientInfo` in per-request `_meta` (keys `io.modelcontextprotocol/clientInfo` etc.), not the initialize handshake — update `client-detection.ts` and our `clientInfoName/Version` logging to read `_meta`.
5. **CLI (`netlify-mcp.ts`)**: still v1 stdio; migrate to `@modelcontextprotocol/server/stdio` (`serveStdio`) when ready.
6. **Verify on the real Netlify Functions runtime** (not just local smoke) and test a real 2026-07-28 client + a 2025 client end-to-end through auth.
7. Watch for the **stable v2 release** (lands with the spec on 2026-07-28) and re-pin off `-beta.4`.

## Recommendation
The architecture is compatible and the transport migration is clean. The gating
work is the **zod v4 upgrade**; everything else is mechanical. Keep `main` on v1
(production) until the stable v2 SDK ships, then land the full migration.
