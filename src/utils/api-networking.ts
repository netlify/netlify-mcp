import path from 'node:path';
import * as fs from 'node:fs/promises';
import envPaths from 'env-paths';
import { runCommand } from './cmd.ts';
import { appendToLog } from './logging.ts';
import { decryptJWE } from '../../netlify/functions/mcp-server/utils.ts';
import { log } from '../../netlify/functions/mcp-server/logger.ts';
import type { TokenIdentity } from '../../netlify/functions/mcp-server/identity.js';

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

export const UNAUTHED_ERROR_PREFIX = 'NetlifyUnauthError:';
export class NetlifyUnauthError extends Error {
  constructor(message?: string) {
    super(`${UNAUTHED_ERROR_PREFIX} ${message || 'unauthenticated request to Netlify MCP API'}`);
    this.name = 'NetlifyUnauthError';
  }
}

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

export const userIsAuthenticated = async (request?: Request): Promise<boolean> => {
  try {
    const token = await getNetlifyAccessToken(request);
    if (!token) {
      return false;
    }
    const response = await authenticatedFetch('/api/v1/user', {}, request);
    if(response.status === 401) {
      return false;
    }
  } catch (error) {
    if (error instanceof NetlifyUnauthError) {
      return false;
    }
    throw error; // rethrow other errors
  }
  return true;
}

/**
 * Recover the identity (userId/teamId) embedded in the JWE bearer token, for
 * attaching to logs. Returns null when there's no request, no JWE bearer token,
 * or a raw personal access token (nfp/nfu/nfo) — those carry no embedded
 * identity. Never throws.
 */
export const getTokenIdentity = async (request?: Request): Promise<TokenIdentity | null> => {
  if (!request) return null;
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const bearer = authHeader.slice(7);
  // Raw PATs are used directly and carry no embedded identity.
  if (bearer.startsWith('nfu') || bearer.startsWith('nfp') || bearer.startsWith('nfo')) {
    return null;
  }

  try {
    const decrypted = await decryptJWE(bearer);
    const identity = (decrypted as any)?.identity;
    return identity && typeof identity === 'object' ? (identity as TokenIdentity) : null;
  } catch {
    return null;
  }
};

export const getNetlifyAccessToken = async (request?: Request): Promise<string> => {

  if (request) {
    const authHeader = request.headers.get('Authorization');
    let token = '';
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const bearerToken = authHeader.slice(7);
      if(bearerToken.startsWith('nfu') || bearerToken.startsWith('nfp') || bearerToken.startsWith('nfo')){
        token = bearerToken;
      }else {
        let decrypted: Record<string, any> | undefined;
        try {
          decrypted = await decryptJWE(bearerToken);
        } catch {
          throw new NetlifyUnauthError('Bearer token is invalid or expired');
        }
        if(decrypted && typeof decrypted.accessToken === 'string') {
          token = decrypted.accessToken;
        } else {
          log.error('decrypted JWE did not contain accessToken', { fields: Object.keys(decrypted ?? {}) });
        }
      }

    }

    if(!token) {
      throw new NetlifyUnauthError('no Bearer token found in Authorization header');
    }
    return token;
  }

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
      throw new NetlifyUnauthError(getAuthTokenMsg);
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


export const authenticatedFetch = async (urlOrPath: string, options: RequestInit = {}, incomingRequest?: Request) => {
  const token = await getNetlifyAccessToken(incomingRequest);
  const url = new URL(urlOrPath, 'https://api.netlify.com')
  const method = (options.method || 'GET').toString().toUpperCase();

  try {
    const response = await unauthenticatedFetch(url.toString(), {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        ...(options.headers || {})
      },
    });

    // Surface failed Netlify API calls as a queryable event. Value-free: method,
    // path, and status only — never request/response bodies or query strings.
    // This runs inside the request's log context, so failures carry the
    // requestId/userId/toolName that triggered them.
    if (!response.ok) {
      log.warn('netlify api call failed', { method, apiPath: url.pathname, status: response.status });
    }
    return response;
  } catch (err) {
    // Network-level failure (DNS, timeout, connection reset) — no HTTP status.
    log.error('netlify api call errored', { method, apiPath: url.pathname, err });
    throw err;
  }
}


export const getAPIJSONResult = async (urlOrPath: string, options: RequestInit = {}, apiInteractionOptions: APIInteractionOptions = {}, incomingRequest?: Request): Promise<any> => {

  if(!apiInteractionOptions.pagination){
    const response = await authenticatedFetch(urlOrPath, options, incomingRequest);

    if(response.status === 401 && incomingRequest) {
      throw new NetlifyUnauthError(`Unauthedenticated request to Netlify API. ${urlOrPath}`);
    }

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

    const response = await authenticatedFetch(url.toString(), options, incomingRequest);

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

export const getSite = async ({ siteId, incomingRequest }: { siteId: string, incomingRequest?: Request }): Promise<NetlifySite> => {
  const res = await authenticatedFetch(`/api/v1/sites/${siteId}`, {}, incomingRequest);

  if (!res.ok) {
    const data = await res.json();
    throw new Error(`Failed to fetch sites, status: ${res.status}, ${data.message}`);
  }

  return await res.json();
}
