
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

### How sign-in is protected

Every authorization goes through a consent page on this server that names the
host the client registered as its redirect. Netlify's own consent screen only
names this server's OAuth app, and anyone can register a client, so this page is
the only place a person can see where their access is going. The page sets a
`__Host-mcp-oauth-txn` cookie, and the sealed `state` sent through
app.netlify.com only completes in the browser holding it.

Every JWE sealed with `JWE_SECRET` carries a `token_use` (`authorization_request`,
`authorization_code`, `access`, `refresh`, `proxy`), and each endpoint accepts
only its own. Tokens minted before `token_use` existed are refused, so the
deploy that introduced it signed every connected client out once.
