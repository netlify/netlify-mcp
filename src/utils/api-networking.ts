import path from 'node:path';
import * as fs from 'node:fs/promises';
import envPaths from 'env-paths';
import { runCommand } from './cmd.js';
import { appendToLog } from './logging.js';

const getAuthTokenMsg = `
You're not logged into Netlify on this computer. Use the netlify cli to login. \`netlify login\`
If you don't have the netlify cli installed, install it by running "npm i -g netlify-cli",
`

const readTokenFromEnv = async () => {
  try {
    // Netlify CLI uses envPaths(...) to build the file path for config.json.
    // https://github.com/netlify/cli/blob/f10fb055ab47bb8e7e2021bdfa955ce6733d5041/src/lib/settings.ts#L6
    // We could import it from the CLI to prevent code duplication,
    // but CLI is way too heavy to be used within an MCP server.
    const OSBasedPaths = envPaths('netlify', { suffix: '' });
    const configPath = path.join(OSBasedPaths.config, 'config.json');
    const configData = await fs.readFile(configPath, { encoding: 'utf-8' });
    const parsedData = JSON.parse(configData.toString());
    const userId = parsedData?.userId;
    return parsedData?.users?.[userId]?.auth?.token;
  } catch {}
  return '';
}

export const getNetlifyAccessToken = async (): Promise<string> => {
  let token = '';

  // allow the PAT to be set just in case
  if (process.env.NETLIFY_PERSONAL_ACCESS_TOKEN) {
    return process.env.NETLIFY_PERSONAL_ACCESS_TOKEN;
  }

  token = await readTokenFromEnv();

  if (!token) {

    const result = await runCommand('netlify login', { env: process.env });

    appendToLog(["Netlify login exit code and output", JSON.stringify(result)]);

    if (result.exitCode === 0) {
      token = await readTokenFromEnv();
    }

    if (!token) {
      throw new Error(getAuthTokenMsg);
    }
  }
  return token;
}

