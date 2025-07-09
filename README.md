# Netlify MCP Server

[Netlify MCP Server](https://docs.netlify.com/welcome/build-with-ai/netlify-mcp-server/) follows the [Model Context Protocol (MCP)](https://modelcontextprotocol.org) to enable code agents to use the Netlify API and CLI—so they can create new projects, build, deploy, and manage your Netlify resources using natural language prompts.

---

## Overview

The Model Context Protocol is an emerging standard protocol for connecting code agents with MCP servers, allowing them to manage resources and perform tasks using natural language. The Netlify MCP Server acts as a bridge, providing API access, CLI tools, prompts, and more for your agents.

You can connect to the Netlify MCP Server using a variety of MCP clients, including:

* Windsurf
* Cursor
* Claude
* Copilot (VSCode)
* Cline
* Warp
* LM Studio
* [See the full list](https://modelcontextprotocol.org/clients)

---

## Use Cases

With Netlify MCP Server, your AI agents can:

* Create, manage, and deploy Netlify projects
* Modify access controls for enhanced project security
* Install or uninstall Netlify extensions
* Fetch user and team information
* Enable and manage form submissions
* Create and manage environment variables and secrets
* and more...
---

## Prerequisites

* **Node.js 22 or higher**
  Check with `node --version`
* **A Netlify account**
* **An MCP client** (e.g., Windsurf, Cursor, Claude, Copilot)

> **Tip:** Install the Netlify CLI globally for the best experience:
> `npm install -g netlify-cli`

---

## MCP Configuration

For the production MCP server, use the following configuration:

Editors with one-click install:

[![Install MCP Server on Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=netlify&config=eyJjb21tYW5kIjoibnB4IC15IEBuZXRsaWZ5L21jcCJ9)

[![Add MCP Server netlify to LM Studio](https://files.lmstudio.ai/deeplink/mcp-install-light.svg)](https://lmstudio.ai/install-mcp?name=netlify&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBuZXRsaWZ5L21jcCJdfQ%3D%3D)

[![Install on VS Code](https://img.shields.io/badge/VS_Code-VS_Code?style=flat-square&label=Install%20Server&color=0098FF)](https://insiders.vscode.dev/redirect/mcp/install?name=netlify&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40netlify%2Fmcp%22%5D%7D)

[![Install on VS Code Insiders Edition](https://img.shields.io/badge/VS_Code_Insiders-VS_Code_Insiders?style=flat-square&label=Install%20Server&color=24bfa5)](https://insiders.vscode.dev/redirect/mcp/install?name=netlify&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40netlify%2Fmcp%22%5D%7D&quality=insiders)

[![Install on Goose](https://img.shields.io/badge/Install_MCP-Goose-black)](goose://extension?cmd=npx&arg=-y&arg=%40netlify%2Fmcp&id=netlify&name=Netlify&description=Build%2C%20deploy%2C%20and%20manage%20sites%20with%20Netlify's%20official%20MCP%20server.)
- use the following link in your browser if link fails to render or open: `goose://extension?cmd=npx&arg=-y&arg=%40netlify%2Fmcp&id=netlify&name=Netlify&description=Build%2C%20deploy%2C%20and%20manage%20sites%20with%20Netlify's%20official%20MCP%20server.`

Configuration for MCP config files:

```json
{
  "mcpServers": {
    "netlify": {
      "command": "npx",
      "args": [
        "-y",
        "@netlify/mcp"
      ]
    }
  }
}
```

For local development, see [Set up local MCP configuration](CONTRIBUTING.md).

---

## Troubleshooting

### Node Version

* Use Node.js 22 or higher for best results.
* If you use `nvm`, run:

  ```bash
  nvm install 22
  nvm use 22
  ```

### Netlify authentication troubleshooting

* If you run into authentication issues, you can temporarily add a [Netlify Personal Access Token (PAT)](https://app.netlify.com/user/applications#personal-access-tokens) to your MCP configuration:

```json
{
  "mcpServers": {
    "netlify-mcp": {
      "command": "npx",
      "args": ["-y", "@netlify/mcp"],
      "env": {
        "NETLIFY_PERSONAL_ACCESS_TOKEN": "YOUR-PAT-VALUE"
      }
    }
  }
}
```

**Do not commit your PAT to your repository!**
Once resolved, remove your PAT from the config.

---

## Generating a New Personal Access Token (PAT)

1. In the Netlify dashboard, select your user icon.
2. Go to **User settings** > **OAuth** > **New access token**.
3. Copy your token and add it (temporarily) to your MCP config as above.
4. Restart or refresh your MCP client.

---

## Resources

* [Model Context Protocol Documentation](https://modelcontextprotocol.org/docs)
* [Official List of MCP Clients](https://modelcontextprotocol.org/clients)
* [Netlify CLI](https://docs.netlify.com/cli/get-started/)
