
## Getting Started

### Clone and Install

```bash
git clone <this-repo>
cd <this-repo>
npm install
```

---

## Set up local MCP configuration

Add a local MCP server to your MCP client by referencing the `netlify-mcp.ts` script:

```json
{
  "mcpServers": {
    "local-netlify-mcp": {
      "command": "npx",
      "args": [
        "tsx",
        "<path-to-repo>/netlify-mcp.ts"
      ]
    }
  }
}
```
---

## MCP Inspector

For debugging or inspecting your setup, run in your repo directory:

```bash
npx @modelcontextprotocol/inspector npx tsx netlify-mcp.ts
```

---

## Server environment variables

These apply to the hosted server (the Netlify functions in `netlify/functions`),
not the local stdio CLI. Every one of them must be set on each site that deploys
this repo.

| Variable | Required | Purpose |
|---|---|---|
| `OAUTH_ISSUER` | yes (deployed) | The server's public origin. Used for OAuth metadata and to build event relay callback URLs, so it must be publicly resolvable — Netlify rejects a private-address webhook target at hook-creation time. Defaults to `http://localhost:8888`. |
| `JWE_SECRET` | yes (deployed) | Seals OAuth access/refresh tokens, the authorization code, the stateless DCR `client_id`, and the `/proxy/:token` JWE. Min 32 chars. Fails closed on any non-localhost issuer. |
| `OAUTH_STORE` | no | `memory` selects the in-memory grant store, allowed only with a localhost `OAUTH_ISSUER` (tests, `netlify dev`). Unset on a deploy: the server uses Netlify Blobs. |
| `EVENTS_RELAY_JWE_SECRET` | only for event subscriptions | Seals event notification relay tokens. Min 32 chars, and it must not derive to the same key as `JWE_SECRET` (only the first 32 characters are used, so a shared prefix collides). **Without it the server does not advertise the `events` capability at all** — subscriptions could not work, so they are not offered. |
| `NTL_AUTH_CLIENT_ID` | yes (deployed) | The Netlify OAuth application the authorize redirect uses. |
| `MCP_VERBOSE_LOGGING` | no | Enables the catch-all request/response body logger. |

Generate the secrets with `openssl rand -base64 48`.

### Rotating secrets

`JWE_SECRET` and `EVENTS_RELAY_JWE_SECRET` are deliberately separate so they can
be rotated independently:

- Rotating **`JWE_SECRET`** invalidates every client registration and token —
  this is the revocation lever for OAuth clients.
- Rotating **`EVENTS_RELAY_JWE_SECRET`** invalidates every live event
  subscription. Teardown is clean rather than silent: the relay answers `410`,
  which makes Netlify delete the underlying notification hooks, so nothing is
  left firing. Clients must call `events/subscribe` again.

Before the split, rotating `JWE_SECRET` would have silently killed every
customer's event notifications as a side effect.

### OAuth grant store (Netlify Blobs)

The OAuth server keeps three kinds of record in the Netlify Blobs store
`oauth-grants` (see `netlify/functions/mcp-server/oauth-store.ts`):

- `txn/<id>` — an authorization in progress: client, redirect, PKCE challenge,
  requested scope, the client's own `state`, and the hash of the browser
  session cookie that started it. Ten-minute lifetime.
- `grant/<id>` — a user's approval of a client: client, redirect, scope,
  identity, which refresh token is current, and whether it is revoked.
- `code/<jti>` — written once when an authorization code is redeemed.

Every write that must happen once uses a conditional write (`onlyIfNew` for
"first one wins", `onlyIfMatch` for compare-and-swap on the etag) with strong
consistency, so the guarantees hold across serverless instances. The store is
provisioned automatically on any Netlify deploy and under `netlify dev`; there
is nothing to create by hand. Records carry `v: 1`; a later shape change bumps
that and reads the old shape explicitly. Expired `txn/` and `code/` records
carry an `expiresAt` metadata field and are harmless if left behind; a
housekeeping sweep can list and delete them.

**If the store is unavailable, the OAuth server refuses**: `/auth`, consent,
the callback, `/token` and `/revoke` answer `503 temporarily_unavailable`
naming the store, and `/mcp` answers 503 for an OAuth access token (PATs are
unaffected). Nothing is issued or honoured on a guess.

### Token types

Every credential is a JWE under `JWE_SECRET` and carries `typ`, `iss` and the
`aud` of the one endpoint that may consume it (`tokens.ts`):

| `typ` | lifetime | consumed by | refused by |
|---|---|---|---|
| `code` | 5 min, redeemable once | `/oauth-server/token` | `/mcp`, `/proxy` |
| `access` | 48 h | `/mcp` | `/token`, `/proxy` |
| `refresh` | 7 d, rotated on use | `/oauth-server/token` | `/mcp`, `/proxy` |
| `proxy` | 30 min | `/proxy/:token/*`, only for its `apisAllowed` path+method | `/mcp`, `/token` |

A raw Netlify PAT (`nfp_`/`nfu_`/`nfo_`) is still accepted at `/mcp` as-is.

### Consent and the browser session

`/auth` validates the client and redirect, records a transaction, sets an
`HttpOnly; SameSite=Lax; Secure` session cookie (`__Host-netlify_mcp_oauth`),
and shows `/oauth-server/consent`, which names the requesting application
(marked **unverified** for a dynamically registered client, since the name is
self-asserted), the exact callback destination, and what access the user is
granting. Approval is a same-origin POST protected by the cookie and a
cookie-derived CSRF token, and the page sends `frame-ancestors 'none'`. Only
after approval does the browser go to `app.netlify.com/authorize`, with the
transaction id as `state`. Netlify returns to `/oauth-server/client-redirect`,
which posts the token to `/oauth-server/server-redirect` in a request body;
that callback requires an approved, unexpired transaction whose session hash
matches the cookie, completes it once, creates the grant and mints the code.
A callback reached without `/auth`, from another browser, or twice, is a 400.

### Revocation

- A code presented twice revokes its grant (RFC 6749 §4.1.2).
- A refresh token presented after it was rotated out revokes its grant
  (OAuth 2.1 §6.1 reuse detection).
- `POST /oauth-server/revoke` (RFC 7009) with an access or refresh token
  revokes its grant.

A revoked grant stops working at the next `/mcp` request and the next
refresh. Proxy tokens are not re-checked (the edge function has no store);
their 30-minute lifetime bounds that exposure.

### Migrating from the untyped tokens (October 2026)

Tokens issued before this change have no `typ`:

- **Legacy access tokens** (`{ accessToken, identity? }`, nothing else) are
  accepted at `/mcp` only, until `LEGACY_ACCESS_TOKEN_SUNSET`
  (2026-10-13T00:00Z, `tokens.ts`). They live 48 h, so all of them expire on
  their own before that; the date is a hard stop. They are never accepted at
  `/proxy` or `/token`.
- **Legacy refresh tokens** (`{ accessToken, type: 'refresh' }`) carry no
  client or grant binding, and the server will not invent one from the
  `client_id` the request submits. They are answered with
  `invalid_grant` ("reconnect the application"). Every integration that uses
  refresh tokens — ChatGPT, Claude, Codex, Azure AI Foundry, IDE clients —
  therefore asks its user to reconnect once, when its current access token
  expires (within 48 h of the deploy). The pinned ChatGPT client id keeps
  working; only its tokens are re-issued.
- **Legacy authorization codes and proxy tokens** are refused. A deploy
  command issued before the deploy fails and must be requested again.
- Dynamic client registrations (`token_use: client_registration`) are
  unchanged and keep working.

Compatibility must never be restored by widening validation or by rotating
`JWE_SECRET` as a reflex: rotation revokes every registration and token at
once, including the ChatGPT pin's users, and widening re-opens the holes this
closes.

**Grants compromised before the change** have no `grant/` record, so they
cannot be revoked individually. They end when their tokens expire: access
tokens within 48 h of the deploy, refresh tokens at their next use (refused
as legacy). If a faster cut is required, rotating `JWE_SECRET` ends all of them
immediately, at the cost of every client registering and every user
reconnecting; decide that deliberately, not as a compatibility fix.
