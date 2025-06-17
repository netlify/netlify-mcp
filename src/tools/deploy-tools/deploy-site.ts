import { z } from 'zod';
import type { DomainTool } from '../types.js';

import { appendErrorToLog, appendToLog } from "../../utils/logging.js";

import { createWriteStream, readFileSync } from "fs";
// @ts-ignore
import archiver from "archiver";
import path from "path";
import { randomUUID } from "crypto";
import { rm } from "fs/promises";
import { authenticatedFetch, getSiteId } from "../../utils/api-networking.js";

const deploySiteParamsSchema = z.object({
  deployDirectory: z.string().describe(`absolute file path to the directory containing the code that should be deployed. Must be the root of the project repo unless specified.`),
  siteId: z.string().optional().describe(`provide the site id of the site of this site. If the agent cannot find the siteId, the user must confirm this is a new site. NEVER assume the user wants a new site. Use 'netlify link' CLI command to link to an existing site and get a site id.`)
});

export const deploySiteDomainTool: DomainTool<typeof deploySiteParamsSchema> = {
  domain: 'deploy',
  operation: 'deploy-site',
  inputSchema: deploySiteParamsSchema,
  cb: async (params, {request}) => {
    const { deployDirectory } = params;

    let deployId = '';
    let buildId = '';

    const id = randomUUID();
    const fileName = `deploy-${Date.now()}-${id}.zip`;

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

      // Using form-data with node-fetch - use /deploys endpoint instead of /builds
      const buildsResp = await authenticatedFetch(`https://api.netlify.com/api/v1/sites/${siteId}/builds`, {
        method: "POST",
        headers: {
          // 'content-type': 'multipart/form-data',  // This includes the Content-Type with boundary
          ...headers,
          'user-agent': 'netlify-mcp'
        },
        body
      }, request);

      const responseStatus = `${buildsResp.status} ${buildsResp.statusText}`;
      appendToLog(["Deploy response status:", responseStatus]);

      // Get response content
      const responseText = await buildsResp.text();
      let deployData;

      try {
        // Try to parse as JSON
        deployData = JSON.parse(responseText);
        appendToLog(["Deploy response body:", JSON.stringify(deployData)]);
      } catch (e) {
        // If not JSON, log as text
        appendToLog(["Deploy response (not JSON):", responseText]);
      }

      if (!buildsResp.ok) {
        const requestId = buildsResp.headers.get('x-request-id') || 'unknown';
        appendErrorToLog(`Failed to deploy site: ${responseStatus} (Request ID: ${requestId})`, responseText);
        throw new Error(`Failed to deploy site: ${responseStatus}`);
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
    return JSON.stringify({ deployId, buildId, monitorDeployUrl: `https://app.netlify.com/sites/${siteId}/deploys/${deployId}` });

  }
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
