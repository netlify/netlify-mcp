#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { getContextConsumerConfig, getNetlifyCodingContext } from "./src/context/coding-context.ts";
import { getPackageVersion } from "./src/utils/version.ts";
import { checkCompatibility } from "./src/utils/compatibility.ts";
import { bindTools } from "./src/tools/index.ts";
import { zipAndBuild } from "./src/tools/deploy-tools/deploy-site.ts";
import { checkDeployStatus } from "./src/tools/deploy-tools/deploy-watch.ts";

// check to see if it's ran as a command to zip and build
const proxyPath = process.argv[process.argv.indexOf('--proxy-path') + 1] || undefined;

if(process.argv.includes('--proxy-path') && proxyPath) {
  (async ()=>{
    console.log('Starting deployment process...');
    checkCompatibility();
    // get directory that the command was run in
    const deployDirectory = process.cwd();
    const siteId = process.argv[process.argv.indexOf('--site-id') + 1] || undefined;

    const proxyUrl = new URL(proxyPath).toString();
    const uploadPath = `${proxyUrl}/api/v1/sites/${siteId}/builds`;
    
    const uploadingInterval = setInterval(() => {
      console.log('Uploading your project...')
    }, 3000); // keep the process alive for a while to see the logs
    const { deployId, buildId } = await zipAndBuild({ deployDirectory, siteId, uploadPath });
    
    clearInterval(uploadingInterval);

    console.log('Deploy process has started...', JSON.stringify({ deployId, buildId, watchDeployProgress: `https://app.netlify.com/sites/${siteId}/deploys/${deployId}` }));

    // check for no-wait flag
    if(process.argv.includes('--no-wait')) {
      process.exit(0);
    }

    const deployEndpoint = `${proxyUrl}/api/v1/deploys/${deployId}`;
    let lastState = '';
    // states: new,pending_review,accepted,rejected,enqueued,building,uploading,uploaded,preparing,prepared,processing,ready,error,retrying
    // wait for the deploy to finish
    setInterval(async () => {
      // checkDeployStatus never throws — a transient fetch/JSON failure here
      // would otherwise become an unhandled rejection and kill the watcher
      // mid-deploy. Poll errors are surfaced as { kind: 'poll-error' } so we
      // log and keep polling.
      const result = await checkDeployStatus(deployEndpoint);
      switch (result.kind) {
        case 'ready':
          console.log('Deploy is ready!', JSON.stringify({ deployId, buildId, siteUrl: result.deploy.url }));
          process.exit(0);
        case 'error':
          console.error('Deploy failed!', JSON.stringify({ deployId, buildId, deployInfo: `https://app.netlify.com/sites/${siteId}/deploys/${deployId}` }));
          process.exit(1);
        case 'unavailable':
          console.error('Error fetching deploy status:', result.statusText);
          process.exit(0);
        case 'poll-error':
          console.error('Error checking deploy status, will retry...', result.message);
          break;
        case 'pending': {
          const sameAsLastState = lastState === result.state;
          console.log(`This project deploy is ${sameAsLastState ? 'still' : 'now'} ${result.state}. Waiting for it to finish...`);
          lastState = result.state;
          break;
        }
      }
    }, 5000);

  })();

}else {

  // Verbose mode is for systems that can't support complex tool schemas using unions/anyOf
  const verboseMode = process.argv.includes('--verbose');

  // v2 stdio serving: the factory builds a fresh server per connection.
  serveStdio(async () => {
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
    server.registerTool(
      "netlify-coding-rules",
      {
        description: "ALWAYS call when writing serverless or Netlify code. required step before creating or editing any type of functions, Netlify sdk/library  usage, etc.",
        inputSchema:{
          creationType: creationTypeEnum
        },
        annotations: {
          readOnlyHint: true
        }
      },
      async ({creationType}) => {

        checkCompatibility();

        const context = await getNetlifyCodingContext(creationType);
        const text = context?.content || '';

        return ({
          content: [{type: "text" as const, text}]
        });
      }
    );

    await bindTools(server, undefined, verboseMode);

    return server;
  });

}
