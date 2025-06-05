
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
