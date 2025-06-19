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
const proxyPath = process.argv[process.argv.indexOf('--proxy-path') + 1] || undefined;

if(proxyPath) {
  (async ()=>{
    console.log('Starting deployment process...');
    checkCompatibility();
    // get directory that the command was run in
    const deployDirectory = process.cwd();
    const siteId = process.argv[process.argv.indexOf('--site-id') + 1] || undefined;

    const proxyUrl = new URL(proxyPath).toString();
    const uploadPath = `${proxyUrl}/api/v1/sites/${siteId}/builds`;
    
    setInterval(() => {
      console.log('Still uploading your project...')
    }, 1000); // keep the process alive for a while to see the logs
    const { deployId, buildId } = await zipAndBuild({ deployDirectory, siteId, uploadPath });
    
    const now = new Date();
    console.log('Deploy process has started...', JSON.stringify({ deployId, buildId, watchDeployProgress: `https://app.netlify.com/sites/${siteId}/deploys/${deployId}` }));

    // check for no-wait flag
    if(process.argv.includes('--no-wait')) {
      process.exit(0);
    }

    const deployEndpoint = `/api/v1/deploys/${deployId}`;
    // states: new,pending_review,accepted,rejected,enqueued,building,uploading,uploaded,preparing,prepared,processing,ready,error,retrying
    // wait for the deploy to finish
    setInterval(async () => {
      const deployLookup = await fetch(deployEndpoint);
      if(deployLookup.ok) {
        const deploy = await deployLookup.json();
        if(deploy.state === 'ready') {
          console.log('Deploy is ready!', JSON.stringify({ deployId, buildId, siteUrl: deploy.url }));
          process.exit(0);
        }else if(deploy.state === 'error') {  
          console.error('Deploy failed!', JSON.stringify({ deployId, buildId, deployInfo: `https://app.netlify.com/sites/${siteId}/deploys/${deployId}` }));
          process.exit(1);
        }

        console.log('Deploy status:', deploy.state, 'at', now.toISOString(), 'will continue waiting...');

      } else {
        console.error('Error fetching deploy status:', deployLookup.statusText);
        process.exit(0);
      }
    }, 5000);

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
