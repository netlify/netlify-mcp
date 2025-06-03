#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getContextConsumerConfig, getNetlifyCodingContext } from "./src/context/coding-context.js";
import { getPackageVersion } from "./src/utils/version.js";
import { checkCompatibility } from "./src/utils/compatibility.js";
import { bindTools } from "./src/tools/index.js";


const server = new McpServer({
  name: "netlify-mcp",
  version: getPackageVersion()
});

// load the consumer configuration for the MCP so
// we can share all of the available context for the
// client to select from.
const contextConsumer = await getContextConsumerConfig();
const availableContextTypes = Object.keys(contextConsumer?.contextScopes || {});
const creationTypeEnum = z.enum(availableContextTypes as [string, ...string[]]);

server.tool(
  "get-netlify-coding-context",
  "ALWAYS call when writing serverless or Netlify code. required step before creating or editing any type of functions, Netlify sdk/library  usage, etc.",
  { creationType: creationTypeEnum },
  async ({creationType}: {creationType: z.infer<typeof creationTypeEnum>}) => {

    checkCompatibility();

    const context = await getNetlifyCodingContext(creationType);
    const text = context?.content || '';

    return ({
      content: [{type: "text", text}]
    });
  }
);

await bindTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
