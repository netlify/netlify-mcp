#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getContextConsumerConfig, getNetlifyCodingContext } from "./src/context/coding-context.ts";
import { getPackageVersion } from "./src/utils/version.ts";
import { checkCompatibility } from "./src/utils/compatibility.ts";
import { bindTools } from "./src/tools/index.ts";
import { zipAndBuild } from "./src/tools/deploy-tools/deploy-site.ts";


// check to see if it's ran as a command to zip and build
if(process.argv.includes('--upload-path')) {
  (async ()=>{
    console.log('Starting zip and build...');
    checkCompatibility();
    // get directory that the command was run in
    const deployDirectory = process.cwd();
    const siteId = process.argv[process.argv.indexOf('--site-id') + 1] || undefined;
    const uploadPath = process.argv[process.argv.indexOf('--upload-path') + 1] || undefined;
    console.log({deployDirectory, siteId, uploadPath});

    setInterval(() => {
      console.log('Still uploading your project...')
    }, 1000); // keep the process alive for a while to see the logs
    const { deployId, buildId } = await zipAndBuild({ deployDirectory, siteId, uploadPath });
    
    console.log(JSON.stringify({ deployId, buildId, monitorDeployUrl: `https://app.netlify.com/sites/${siteId}/deploys/${deployId}` }));

    process.exit(0);
  })();

}else {

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
    "netlify-coding-rules",
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

}
