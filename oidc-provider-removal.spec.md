# Spec: Remove `oidc-provider`, hand-build the OAuth Authorization Server

**Status:** Proposed
**Author:** (fill in)
**Scope:** `netlify/functions/oauth-server.ts` and its `mcp-server/` helpers
**Estimated effort:** ~1 focused day incl. tests

---

## 1. Motivation

This server is **not an OIDC provider**. It is a thin, stateless OAuth 2.1
Authorization Server that fronts Netlify's own OAuth: the human authenticates at
`app.netlify.com`, and we wrap the resulting Netlify token in a JWE. It exists to
satisfy the MCP authorization spec (RFC 8414 + RFC 9728 + RFC 7591 + PKCE) so AI
clients can bootstrap.

Today that job is done by `oidc-provider` v9 wrapped in `serverless-http` — but
**almost none of the real work runs through it.** Every real endpoint is already
hand-rolled in `auth-flow.ts` and `client-registry.ts`. `oidc-provider` is
load-bearing for only two things, and both are hollow:

1. **The AS metadata document.** We ask `oidc-provider` for its
   `openid-configuration`, then immediately strip 11 OIDC-only fields, override
   `scopes_supported`, force `authorization_response_iss_parameter_supported=false`,
   and rewrite every URL (`oauth-server.ts:258-301`). We fight the library to turn
   its OIDC doc back into a plain OAuth 2.1 doc that is 100% derivable from
   constants we already hold.

2. **A catch-all** (`oauth-server.ts:318`) that serves endpoints which are all
   either disabled (`introspection`, `userinfo`), 404 (`jwks → /404-jwks`), or
   non-functional because the `ClientAdapter` is entirely no-ops (`deviceFlow`,
   PAR, backchannel need a store; `revocation` is meaningless for stateless JWE —
   there is nothing to revoke).

Cost of keeping it:

- A fresh `new Provider(...)` is constructed **on every request** (`oauth-server.ts:170`),
  then wrapped in `serverless-http` per request — real cold-path work and setup
  validation for a doc we could return as a literal.
- Three dependencies (`oidc-provider`, `@types/oidc-provider`, `serverless-http`)
  and a no-op `ClientAdapter` we maintain only to keep the library quiet.
- We advertise ~15 endpoints, most of which don't work, which is misleading to
  clients and to us.

**Reliability and accuracy are the priority.** A hand-built AS removes a moving
part, makes the advertised surface honest, and is trivially testable byte-for-byte.

---

## 2. Goals / Non-goals

### Goals
- Remove `oidc-provider`, `@types/oidc-provider`, and `serverless-http` entirely.
- Serve RFC 8414 AS metadata and RFC 9728 protected-resource metadata from
  hand-built static documents.
- Advertise **only** the endpoints the MCP auth spec defines and that we actually
  implement.
- Preserve every existing custom behavior and client-compat workaround verbatim.
- Keep the server stateless (JWE tokens, JWE `client_id`) — no storage change.

### Non-goals
- No change to token format, `JWE_SECRET` handling, or the `jose` helpers in
  `utils.ts`.
- No change to the MCP request path (`mcp.ts` never touches `oidc-provider`).
- No new features (introspection, userinfo, device flow, revocation, JWKS) — we
  are removing the *advertisement* of features we never implemented.
- No change to the static-client or stateless-DCR model.

---

## 3. What the MCP auth spec actually requires

MCP authorization = OAuth 2.1 + these RFCs, nothing more:

| RFC | Purpose | Endpoint / doc |
|-----|---------|----------------|
| RFC 9728 | Protected Resource Metadata | `/.well-known/oauth-protected-resource/mcp` |
| RFC 8414 | Authorization Server Metadata | `/.well-known/oauth-authorization-server` |
| RFC 7591 | Dynamic Client Registration | `POST /oauth-server/reg` (+ `/register` alias) |
| OAuth 2.1 + PKCE (S256) | Authorization + token | `/oauth-server/auth`, `/oauth-server/token` |

**Not in the MCP spec, therefore dropped:** revocation (RFC 7009), introspection
(RFC 7662), UserInfo, JWKS, device flow (RFC 8628), PAR (RFC 9126), backchannel,
end-session. None are implemented today; all are removed from code and metadata.

Revocation note: the only revocation lever for these stateless JWE tokens is
`JWE_SECRET` rotation (invalidates all registrations/tokens at once). This is
already documented in `client-registry.ts` and unchanged by this work.

---

## 4. Target architecture

`oauth-server.ts` becomes a plain router with no library underneath. Every branch
is either an existing custom handler or a small static responder:

```
OPTIONS *                                        -> 204 (CORS preflight)   [unchanged]
GET  /.well-known/oauth-protected-resource[/mcp] -> buildProtectedResourceMetadata()  [simplified]
GET  /.well-known/oauth-authorization-server     -> buildAuthServerMetadata()          [NEW static]
GET  /.well-known/openid-configuration           -> buildAuthServerMetadata()          [NEW alias, compat]
GET  /oauth-server/auth                          -> handleAuthStart()          [unchanged]
GET  /oauth-server/client-redirect               -> handleClientSideAuthExchange()  [unchanged]
GET  /oauth-server/server-redirect               -> handleServerSideAuthRedirect()  [unchanged]
POST /oauth-server/token                         -> handleCodeExchange()       [unchanged]
POST /oauth-server/reg  (+ /register alias)      -> handleClientRegistration() [unchanged]
*                                                -> 404 invalid_request        [NEW fallback]
```

Removed entirely: `ClientAdapter`, `configuration`, `invokeOIDCProvider`, the
`Provider` construction, the `serverless(...)` wrapper, and the field-stripping /
`urlsToHTTP` post-processing of the metadata doc (the static doc is already
correct, so nothing to strip or rewrite).

---

## 5. The final metadata documents

These are the exact shapes to emit. Values come from constants already in the
file (`SUPPORTED_SCOPES`, the `*Path` route constants) and `getOAuthIssuer()`.

### 5.1 Authorization Server Metadata (RFC 8414)

`GET /.well-known/oauth-authorization-server`
(and `/.well-known/openid-configuration` — same body, compat alias)

```jsonc
{
  "issuer": "<getOAuthIssuer()>",
  "authorization_endpoint": "<issuer>/oauth-server/auth",
  "token_endpoint": "<issuer>/oauth-server/token",
  "registration_endpoint": "<issuer>/oauth-server/reg",
  "scopes_supported": ["offline_access", "read", "write", "claudeai"],
  "response_types_supported": ["code"],
  "response_modes_supported": ["query"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
  "code_challenge_methods_supported": ["S256"]
}
```

Notes:
- All endpoint URLs are built with `new URL(path, getOAuthIssuer()).toString()`
  so they byte-match the issuer (trailing-slash canonicalization already handled
  by `getOAuthIssuer()`). No `urlsToHTTP` pass needed.
- `authorization_response_iss_parameter_supported` is **omitted** (not `false`).
  We still EMIT `iss` on the authorization redirect (`auth-flow.ts:366`); we
  simply don't advertise it — omission and `false` are equivalent to a client,
  and this drops the Codex-workaround branch and its `TODO(2026-10-02)`.
- `scopes_supported` intentionally omits `openid` (this is not OIDC).

### 5.2 Protected Resource Metadata (RFC 9728)

`GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`

Body is unchanged from today (it was already hand-built); the only change is it
no longer calls the provider to read the issuer — it uses `getOAuthIssuer()`
directly:

```jsonc
{
  "resource": "<issuer>/mcp",
  "authorization_servers": ["<getOAuthIssuer()>"],
  "scopes_supported": ["offline_access", "read", "write", "claudeai"],
  "bearer_methods_supported": ["header"]
}
```

---

## 6. File-by-file change plan

### 6.1 `netlify/functions/oauth-server.ts` (primary rewrite)

Remove:
- `import serverless from "serverless-http";`
- `import { Provider } from "oidc-provider";`
- `import type { Configuration, ClientMetadata } from "oidc-provider";`
- the entire `ClientAdapter` class (lines 39-86)
- the `configuration` object (lines 88-153)
- `invokeOIDCProvider` (lines 156-181)
- the AS-metadata field-stripping block (lines 256-302)
- the catch-all delegation + `urlsToHTTP` post-processing (lines 317-333)

Add:
- `buildAuthServerMetadata()` and `buildProtectedResourceMetadata()` (see §7),
  either inline or in a new `mcp-server/metadata.ts` (preferred for testability).
- explicit routing for the two AS well-known paths + the `openid-configuration`
  alias.
- a terminal `404 invalid_request` fallback replacing the catch-all.

Keep unchanged: CORS/OPTIONS handling, `withLogContext` wrapper, the DCR /
authorize / redirect / token branch dispatch, `SUPPORTED_SCOPES`, the `*Path`
constants, the `/register` alias rewrite, `addCommonHeadersToHandlerResp`.

### 6.2 `netlify/functions/mcp-server/oauth-clients.ts` (type-only fix)

Line 1 imports `ClientMetadata` from `oidc-provider` purely as a type for the
`staticClients` array. Replace with a local interface (or reuse the
`RegisteredClient` shape from `client-registry.ts`). Suggested minimal type:

```ts
export interface StaticClient {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope?: string;
}
```

`getClientById` returns `StaticClient | undefined`. `resolveClient` in
`client-registry.ts` already reads these fields defensively (`?? []` etc.), so no
call-site changes are required there.

### 6.3 `package.json`

Remove from `dependencies`: `oidc-provider`, `serverless-http`.
Remove from `devDependencies`: `@types/oidc-provider`.
Run `npm install` to update the lockfile. Confirm nothing else imports them
(verified: only `oauth-server.ts` and the `oauth-clients.ts` type import; all
other mentions are comments in `client-registry.ts`, `auth-flow.ts`, and a test).

### 6.4 Comment cleanup (non-functional)

These comments reference oidc-provider's behavior as justification and can be
kept or reworded; they are not blockers:
- `client-registry.ts:79` (`application_type` inference rationale)
- `auth-flow.ts:442` (same)
- `client-registry.test.ts:31`
Recommendation: reword to state the rule as our own invariant rather than "what
oidc-provider rejected," so the reasoning survives the dependency's removal.

---

## 7. New code (reference implementation)

New file `netlify/functions/mcp-server/metadata.ts`:

```ts
import { getOAuthIssuer } from "./utils.ts";

// The scopes this AS grants. Keep in sync with SUPPORTED_SCOPES in oauth-server.ts
// (import from a shared module to avoid drift — see note below).
const abs = (path: string) => new URL(path, getOAuthIssuer()).toString();

export function buildAuthServerMetadata(scopesSupported: string[]) {
  return {
    issuer: getOAuthIssuer(),
    authorization_endpoint: abs("/oauth-server/auth"),
    token_endpoint: abs("/oauth-server/token"),
    registration_endpoint: abs("/oauth-server/reg"),
    scopes_supported: scopesSupported,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
  };
}

export function buildProtectedResourceMetadata(scopesSupported: string[]) {
  return {
    resource: abs("/mcp"),
    authorization_servers: [getOAuthIssuer()],
    scopes_supported: scopesSupported,
    bearer_methods_supported: ["header"],
  };
}
```

To avoid `SUPPORTED_SCOPES` drift, move that constant into `metadata.ts` (or a
small `oauth-config.ts`) and import it in both `oauth-server.ts` and here.

Routing sketch in `oauth-server.ts` (replaces lines 237-333):

```ts
if (getProtectedResource) {
  return jsonResponse(200, buildProtectedResourceMetadata(SUPPORTED_SCOPES));
}
if (getAuthorizationServer || parsedUrl.pathname.endsWith("/.well-known/openid-configuration")) {
  return jsonResponse(200, buildAuthServerMetadata(SUPPORTED_SCOPES));
}

if (isAuthPath)               return await handleAuthStart(reqObj);
if (isClientRedirectPath)     return await handleClientSideAuthExchange();
if (isServerRedirectPath)     return await handleServerSideAuthRedirect(reqObj);
if (isCodeExchangePath)       return await handleCodeExchange(reqObj);
if ((isRegistrationPath || isRegisterAlias) && req.httpMethod === "POST") {
  return await handleClientRegistration(reqObj, SUPPORTED_SCOPES);
}

// Nothing else is a real endpoint anymore.
return oauthError(404, "invalid_request", `No such endpoint: ${parsedUrl.pathname}`, "router");
```

(`jsonResponse` = tiny helper returning `{ statusCode, headers: {'Content-Type':
'application/json'}, body: JSON.stringify(...) }`; `oauthError` already exists in
`auth-flow.ts` — export it or add a local equivalent.)

---

## 8. Testing plan

### 8.1 Golden-fixture diff (highest value — do this first)
Before changing code, capture the *current* live output of both well-known docs
(against a deployed or `netlify dev` instance) and save as fixtures. Then assert
the new `buildAuthServerMetadata()` / `buildProtectedResourceMetadata()` produce
the same fields, minus the intentionally-dropped ones. This converts the scariest
part (client bootstrap) into a reviewable diff. Expected deltas vs. today:
- **dropped:** all 11 `id_token*/jwks_uri/claims*/subject_types*/userinfo*` fields
  (already stripped today, so no client sees them change), plus
  `revocation_endpoint`, `device_authorization_endpoint`, `end_session_endpoint`,
  `registration_endpoint`-management fields, and
  `authorization_response_iss_parameter_supported`.
- **unchanged:** issuer, authorization/token/registration endpoints,
  scopes_supported, response_types, grant_types, code_challenge_methods,
  token_endpoint_auth_methods.

### 8.2 Unit tests (`metadata.test.ts`, Node built-in `node --test`)
- issuer + all endpoint URLs are absolute and share the issuer origin.
- `code_challenge_methods_supported` is exactly `["S256"]` (PKCE is mandatory).
- `scopes_supported` excludes `openid`.
- `openid-configuration` alias returns the identical body to
  `oauth-authorization-server`.
- unknown path under `/oauth-server/*` returns 404 with an `invalid_request` body.

### 8.3 Existing suite (must stay green, unchanged)
`client-registry.test.ts`, `api-networking.test.ts`, `request-signals.test.ts`,
`logging.test.ts` — these cover the custom logic that is staying and must not
regress. Run `npm test`.

### 8.4 Manual end-to-end (pre-merge gate)
Full interactive auth against at least one real client — **Claude** (primary),
ideally also **Codex** (the `iss` edge case) and a **loopback CLI** client
(Cursor/VS Code). Verify: discovery → DCR → authorize → Netlify login →
code exchange → tool call succeeds; and a refresh_token grant succeeds.

### 8.5 Typecheck / build
`tsc` (or the project's typecheck) must pass after removing the `oidc-provider`
types; `npm run build` (tsup) must succeed.

---

## 9. Risks & mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| A client reads a metadata field we dropped and breaks | High | Golden-fixture diff (§8.1); all dropped fields were already OIDC-only/stripped or dead endpoints no MCP client uses. |
| A client probes `/.well-known/openid-configuration` directly (served today by the catch-all) | Medium | Alias it to the same static AS doc (§4, §7). |
| Losing a client-compat workaround during the rewrite | Medium | Preserve verbatim: Codex `iss` behavior (still emitted in `auth-flow.ts`), `/register` alias, `client_secret_basic` parsing, loopback redirect matching, `claudeai` scope. None depend on oidc-provider. |
| Metadata endpoint URLs stop byte-matching the issuer | Medium | Build every URL via `new URL(path, getOAuthIssuer())`; `getOAuthIssuer()` already canonicalizes the trailing slash. Covered by a unit test. |
| A client actually depended on the revocation endpoint | Low | It was a no-op (stateless JWE). If one 400s on revoke post-change, we can add a `200 {}` stub later — but not advertised, per decision below. |

Explicitly **low-risk / unaffected:** token format, `JWE_SECRET`, `jose` helpers,
the MCP request path (`mcp.ts`), storage model (still none), static & stateless
client resolution.

---

## 10. Decisions (resolved)

- **Advertise only spec-required, implemented endpoints.** Drop revocation,
  introspection, userinfo, jwks, device flow, PAR, backchannel, end-session from
  both code and metadata. (Owner decision: "This is only for Netlify MCP — if
  those aren't in the spec, we don't need them.")
- **Keep the `openid-configuration` path as a compat alias** to the AS doc, even
  though we're not OIDC, because some MCP clients probe it first.
- **Omit** `authorization_response_iss_parameter_supported` rather than set it
  `false`; keep emitting `iss` on the redirect.

## 11. Open questions
- None blocking. Optional follow-up: fold `SUPPORTED_SCOPES` and the `*Path`
  route constants into a single `oauth-config.ts` so metadata and routing share
  one source of truth.

---

## 12. Rollout & rollback

- Ship behind a normal deploy; no data migration, no env changes required
  (`JWE_SECRET`, `OAUTH_ISSUER`, `NTL_AUTH_CLIENT_ID` all unchanged).
- **Rollback:** single-commit revert restores `oidc-provider`. Because token
  format and `JWE_SECRET` are untouched, tokens/registrations issued before,
  during, or after the change remain valid across a rollback — no client is
  forced to re-auth in either direction.
- Suggested sequence: land golden-fixture tests first (green against current
  code), then the rewrite (fixtures prove parity), then remove deps.

---

## 13. Change checklist

- [ ] Add golden-fixture tests capturing current well-known docs.
- [ ] Add `mcp-server/metadata.ts` with the two builders + shared `SUPPORTED_SCOPES`.
- [ ] Rewrite `oauth-server.ts` routing; delete `ClientAdapter`, `configuration`,
      `invokeOIDCProvider`, `Provider`, `serverless` usage and metadata mangling.
- [ ] Replace `ClientMetadata` type import in `oauth-clients.ts` with local type.
- [ ] Add `metadata.test.ts` (§8.2).
- [ ] Remove `oidc-provider`, `@types/oidc-provider`, `serverless-http` from
      `package.json`; `npm install`.
- [ ] Reword oidc-provider-referencing comments (§6.4).
- [ ] `npm test` green; typecheck + `npm run build` pass.
- [ ] Manual e2e: Claude (+ Codex + loopback CLI).
