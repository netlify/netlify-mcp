import path from 'node:path';
import * as fs from 'node:fs/promises';
import envPaths from 'env-paths';
import { runCommand } from './cmd.js';
import { appendToLog } from './logging.js';

interface APIInteractionOptions {
  pagination?: boolean;
  pageSize?: number;
  pageLimit?: number;
  pageOffset?: number;
  failureCallback?: (response: Response) => string | void;
}

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

export const unauthenticatedFetch = async (url: string, options: RequestInit = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      'user-agent': 'netlify-mcp',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    },
  });
  return response;
}


export const authenticatedFetch = async (urlOrPath: string, options: RequestInit = {}) => {
  const token = await getNetlifyAccessToken();
  const url = new URL(urlOrPath, 'https://api.netlify.com')
  return unauthenticatedFetch(url.toString(), {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {})
    },
  });
}

export const getAPIJSONResult = async (urlOrPath: string, options: RequestInit = {}, apiInteractionOptions: APIInteractionOptions = {}): Promise<any> => {

  if(!apiInteractionOptions.pagination){
    const response = await authenticatedFetch(urlOrPath, options);
    if (!response.ok) {
      if(apiInteractionOptions.failureCallback){
        return apiInteractionOptions.failureCallback(response);
      }
      throw new Error(`Failed to fetch API: ${response.status}`);
    }

    const data = await response.text();
    if (!data) {
      return '';
    }

    try{
      return JSON.parse(data);
    } catch (e) {
      if (apiInteractionOptions.failureCallback) {
        return apiInteractionOptions.failureCallback(response);
      }
      return data;
    }
  }

  const currentTime = Date.now();
  const maxDuration = 22000; // 22 seconds

  let apiResults = [];
  let page = 1 + (apiInteractionOptions.pageOffset || 0);

  // avoid unbounded requests
  let pageLimit = apiInteractionOptions.pageLimit || 100;
  const pageSize = apiInteractionOptions.pageSize || 20;

  while (true) {

    const url = new URL(urlOrPath, 'https://api.netlify.com')
    url.searchParams.set('page', page.toString());
    url.searchParams.set('page_size', pageSize.toString());

    const response = await authenticatedFetch(url.toString(), options);

    if (!response.ok) {
      if (apiInteractionOptions.failureCallback) {
        return apiInteractionOptions.failureCallback(response);
      }
      throw new Error(`Failed to fetch API: ${response.status}`);
    }

    const resultRaw = await response.text();

    if (!resultRaw) {
      break;
    }

    const result = JSON.parse(resultRaw);

    const lastResultTime = Date.now();
    const duration = (lastResultTime - currentTime) / 1000;
    appendToLog(`Fetched page ${page}, received ${result.length} sites, total ${apiResults.length}, duration: ${duration} seconds`);

    if (Array.isArray(result)) {

      apiResults.push(...result);

      appendToLog(`Fetched page ${page}, received ${result.length} sites, total ${apiResults.length}`);

      page++;

      if (result.length < pageSize || page > pageLimit || duration > maxDuration) {
        break;
      }

    } else {
      break;
    }
  }

  return apiResults;
}

export type NetlifySite = {
  id: string;
  name: string;
  url: string;
  ssl_url: string;
  admin_url: string;
  user_id: string;
  account_id: string;
  account_slug: string;
  account_name: string;
  account_type: string;
};

export const getSiteId = async ({ projectDir }: { projectDir: string }): Promise<string> => {
  const netlifySiteStatePath = path.join(projectDir, '.netlify', 'state.json');
  const data = await fs.readFile(netlifySiteStatePath);
  const parsedData = JSON.parse(data.toString());
  return parsedData.siteId;
}

export const getSite = async ({ siteId }: { siteId: string }): Promise<NetlifySite> => {
  const res = await authenticatedFetch(`/api/v1/sites/${siteId}`);

  if (!res.ok) {
    const data = await res.json();
    throw new Error(`Failed to fetch sites, status: ${res.status}, ${data.message}`);
  }

  return await res.json();
}
