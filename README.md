## Running locally

- open this repo locally
- run `npm install`
- run `ntl dev`

this should start up an MCP server (generally at `http://localhost:8888`)

Now this can be used to configure your MCP.


## Command for MCP Inspector

in the netlify-mcp repo dir

```bash
npx @modelcontextprotocol/inspector -e NETLIFY_PERSONAL_ACCESS_TOKEN={your-netlify-personal-access-token-this-is-temporary} npx tsx netlify-mcp.ts
```

## Server configs for local
```json
{
  "mcpServers": {
    "local-netlify-mcp": {
      "command": "npx",
      "args": [
        "tsx",
        "<path-to-repo>/netlify-mcp.ts"
      ],
      "env": {
        "NETLIFY_PERSONAL_ACCESS_TOKEN": "<your-netlify-personal-access-token (this is temporary)>"
      }
    }
  }
}
```



## Running the production version

```json
{
  "mcpServers": {
    "netlify-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@netlify/netlify-mcp"
      ],
      "env": {
        "NETLIFY_PERSONAL_ACCESS_TOKEN": "<your-netlify-personal-access-token (this is temporary)"
      }
    }
  }
}
```
