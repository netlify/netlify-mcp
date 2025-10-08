import { z } from 'zod';
import type { DomainTool } from '../types.js';

import { appendErrorToLog, appendToLog } from "../../utils/logging.ts";

import { createWriteStream, readFileSync, promises as fs } from "fs";
// @ts-ignore
import archiver from "archiver";
import path from "path";
import { randomUUID } from "crypto";
import { rm } from "fs/promises";
import { authenticatedFetch, getNetlifyAccessToken, getSiteId, unauthenticatedFetch } from "../../utils/api-networking.ts";
import { createJWE, getOAuthIssuer } from '../../../netlify/functions/mcp-server/utils.js';

const deploySiteRemotelyParamsSchema = z.object({
  siteId: z.string().optional().describe(`provide the site id of the site of this site. If the agent cannot find the siteId, the user must confirm this is a new site. NEVER assume the user wants a new site. Use 'netlify link' CLI command to link to an existing site and get a site id.`)
});

export const deploySiteRemotelyDomainTool: DomainTool<typeof deploySiteRemotelyParamsSchema> = {
  domain: 'deploy',
  operation: 'deploy-site',
  inputSchema: deploySiteRemotelyParamsSchema,
  omitFromLocalMCP: true,
  toolAnnotations: {
    readOnlyHint: false,
  },
  cb: async (params, {request}) => {

    const proxyToken = await createJWE({
      accessToken: await getNetlifyAccessToken(request),
      siteId: params.siteId,
      // TODO: in the future, lock this down even further
      apisAllowed: [
        {
          path: `/api/v1/sites/${params.siteId}/builds`,
          method: 'POST'
        },
        // allow reads of deploys
        {
          path: '/api/v1/deploys/:deploy_id',
          method: 'GET'
        }
      ]
    }, '30m');

    const proxyPath = `/proxy/${proxyToken}`;
    
    return `

To deploy this to Netlify, run the following command within the source/repo directory:

\`\`\`shell
npx -y @netlify/mcp@latest --site-id ${params.siteId} --proxy-path "${getOAuthIssuer()}${proxyPath}"
\`\`\`

This command will upload the code repo and run a build in Netlify's build system.

By default, the command will wait for the deployment to completely finish (which can take time). 
If you want to skip waiting for the deployment to finish, you can add the \`--no-wait\` flag to the command.
`
  }
};

const deploySiteParamsSchema = z.object({
  deployDirectory: z.string().describe(`absolute file path to the directory containing the code that should be deployed. Must be the root of the project repo unless specified.`),
  siteId: z.string().optional().describe(`provide the site id of the site of this site. If the agent cannot find the siteId, the user must confirm this is a new site. NEVER assume the user wants a new site. Use 'netlify link' CLI command to link to an existing site and get a site id.`)
});

export const deploySiteDomainTool: DomainTool<typeof deploySiteParamsSchema> = {
  domain: 'deploy',
  operation: 'deploy-site',
  inputSchema: deploySiteParamsSchema,
  toolAnnotations: {
    readOnlyHint: false,
  },
  omitFromRemoteMCP: true,
  cb: async (params, {request}) => {

    const { deployDirectory } = params;

    if (!deployDirectory) {
      throw new Error("Missing required parameter: deployDirectory");
    }

    let siteId = params.siteId;
    if (!siteId) {
      siteId = await getSiteId({ projectDir: deployDirectory });
    }

    if (!siteId) {
      throw new Error("Missing required parameter: siteId. Get from .netlify/state.json file or use 'netlify link' CLI command to link to an existing site and get a site id.");
    }
    
    const {deployId, buildId} = await zipAndBuild({ deployDirectory, siteId, request });
    
    return JSON.stringify({ deployId, buildId, monitorDeployUrl: `https://app.netlify.com/sites/${siteId}/deploys/${deployId}` });
  }
}


export async function zipAndBuild({deployDirectory, siteId, request, uploadPath}: {
  deployDirectory: string; 
  siteId?: string; 
  request?: Request;
  uploadPath?: string; 
}){
  let deployId = '';
  let buildId = '';
  
  const id = randomUUID();
  const fileName = `deploy-${Date.now()}-${id}.zip`;

  const zipPath = path.resolve(deployDirectory, fileName);

  const deleteZip = async () => {
    try {
      await rm(zipPath);
    } catch { }
  };

  try {

    await zipFiles({ directory: deployDirectory, zipPath });

    appendToLog(["Deploying site...", JSON.stringify({ zipPath })]);

    const { headers, body } = await prepareZipUpload(zipPath);
    const reqInit = {
      method: "POST",
      headers: {
        // 'content-type': 'multipart/form-data',  // This includes the Content-Type with boundary
        ...headers,
        'user-agent': 'netlify-mcp'
      },
      body
    };

    let buildsResp;
    if(uploadPath){
      buildsResp = await unauthenticatedFetch(uploadPath, reqInit);
    }else {
      // Using form-data with node-fetch - use /deploys endpoint instead of /builds
      buildsResp = await authenticatedFetch(`https://api.netlify.com/api/v1/sites/${siteId}/builds`, reqInit, request);
    }
    
    const responseStatus = `${buildsResp.status} ${buildsResp.statusText}`;
    appendToLog(["Deploy response status:", responseStatus]);
    if (!buildsResp.ok) {
      const requestId = buildsResp.headers.get('x-request-id') || 'unknown';
      appendErrorToLog(`Failed to deploy site: ${responseStatus} (Request ID: ${requestId})`);
      throw new Error(`Failed to deploy site: ${responseStatus}`);
    }

    // Get response content
    const responseText = await buildsResp.text();
    let deployData;

    appendToLog(['original response text', responseText || '<empty>']);
    try {
      // Try to parse as JSON
      deployData = JSON.parse(responseText);

      deployData = Array.isArray(deployData) ? deployData[0] : deployData; // Handle array response
      appendToLog(["Deploy response body:", JSON.stringify(deployData)]);
    } catch (e) {
      // If not JSON, log as text
      appendToLog(["Deploy response (not JSON):", responseText]);
    }

    // Extract deploy ID from response
    deployId = deployData?.deploy_id || '';
    buildId = deployData?.id || '';
    appendToLog(["Deployment started with ID:", deployId]);
  } catch (error) {
    appendErrorToLog(`Failed to deploy site: ${error}`);
    await deleteZip();
    throw new Error(`Failed to deploy site: ${error}`);
  }

  await deleteZip();

  // ensure the site id is set on the site if we know it
  try {
    const stateFilePath = path.resolve(deployDirectory, '.netlify', 'state.json');
    let stateFileContent = '{}';

    try {
      stateFileContent = await fs.readFile(stateFilePath, 'utf-8');
    } catch (error) {
      // If the file doesn't exist, we'll create it later
    }

    let state: Record<string, any> = {};

    try {
      state = JSON.parse(stateFileContent) as Record<string, any>;
    } catch { }

    // If the siteId is not present, we add it
    if (!state.siteId) {
      state.siteId = siteId;
      await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
      await fs.writeFile(stateFilePath, JSON.stringify(state, null, 2));
    }
  } catch (error) {
    appendErrorToLog(`Failed to read or write state file: ${error}`);
  }

  return { deployId, buildId };
}


function zipFiles({ directory, zipPath }: { directory: string; zipPath: string; }) {
  return new Promise((resolve, reject) => {

    appendToLog(["Zipping files...", JSON.stringify({ directory, zipPath })]);

    // Create a file to stream archive data to
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", {
      zlib: { level: 9 } // Sets the compression level
    });

    // Listen for all archive data to be written
    output.on("close", function () {
      appendToLog(["Zip completed", JSON.stringify({ directory, zipPath })]);
      resolve({ zipPath });
    });

    // Good practice to catch this error explicitly
    archive.on("error", function (err: any) {
      appendErrorToLog(`Failed to zip files: ${err}`);
      reject(err);
    });

    // Pipe archive data to the file
    archive.pipe(output);

    // Add files using glob pattern with explicit ignore patterns
    archive.glob('**/*', {
      cwd: directory,
      ignore: [
        'node_modules/**',
        '.git/**',
        '.netlify/**',
        '.DS_Store',
        'deploy-*.zip',  // Exclude any previously created deploy zip files
        '.env',          // Exclude environment files
        'coverage/**',   // Exclude test coverage reports
        'tmp/**'         // Exclude temporary files
      ],
      dot: true // Include other dotfiles like .gitignore that might be needed
    });

    // Finalize the archive (i.e. we are done appending files)
    archive.finalize();
  });
}


const prepareZipUpload = async (zipPath: string) => {

  const boundary = `----NetlifyFormBoundary${randomUUID().replace(/-/g, '')}`;

  // Read the file content
  const fileContent = readFileSync(zipPath);
  const fileName = path.basename(zipPath);

  // Create multipart form data manually
  const formDataParts = [];

  // Add file part
  formDataParts.push(
    Buffer.from(`--${boundary}\r\n` +
      `Content-Disposition: form-data; name="zip"; filename="${fileName}"\r\n` +
      `Content-Type: application/zip\r\n\r\n`)
  );
  formDataParts.push(fileContent);
  formDataParts.push(Buffer.from(`\r\n`));

  // Close the form data
  formDataParts.push(Buffer.from(`--${boundary}--\r\n`));

  // Combine all parts into a single buffer
  const body = Buffer.concat(formDataParts);

  // Set up headers
  const headers = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': body.length.toString(),
  };

  return { headers, body };
}
