import path from 'node:path';
import * as fs from 'node:fs/promises';
import { LEGACY_STORAGE_ENV_VAR, readStoredAPIToken, type StoredAPIToken } from '@netlify/dev-utils';
import { runCommand } from './cmd.ts';
import { appendToLog } from './logging.ts';
import { loginSpawnEnv } from './login-attribution.ts';
import { decryptJWE } from '../../netlify/functions/mcp-server/utils.ts';
import { isTokenTypeAllowed, TOKEN_TYPE } from '../../netlify/functions/mcp-server/token-types.ts';
import { log } from '../../netlify/functions/mcp-server/logger.ts';
import { flagNetlify401 } from '../../netlify/functions/mcp-server/request-signals.ts';
import type { TokenIdentity } from '../../netlify/functions/mcp-server/identity.js';

interface APIInteractionOptions {
  pagination?: boolean;
  pageSize?: number;
  pageLimit?: number;
  pageOffset?: number;
  failureCallback?: (response: Response) => string | void;
  // Statuses the caller is about to silently retry (e.g. a 422 name conflict)
  // and so doesn't want logged as a failure — anything not listed here still
  // logs as usual. Only honored on the non-paginated path.
  quietStatuses?: number[];
}

const getAuthTokenMsg = `Netlify login didn't complete.
Retry this tool to reopen the Netlify login page in the browser, and ask the user to finish logging in there.
If the \`netlify\` command isn't installed, install it first with \`npm install -g netlify-cli\`.`

export const UNAUTHED_ERROR_PREFIX = 'NetlifyUnauthError:';
export class NetlifyUnauthError extends Error {
  constructor(message?: string) {
    super(`${UNAUTHED_ERROR_PREFIX} ${message || 'unauthenticated request to Netlify MCP API'}`);
    this.name = 'NetlifyUnauthError';
  }
}

// Thrown when the Netlify API returns a non-OK status. Carries the status so
// callers can tell an expected client outcome (4xx: not-found, validation) apart
// from a genuine server/network failure (5xx), and log at the right severity.
// The default message is unchanged (`Failed to fetch API: <status>`) for
// compatibility; callers that know what the status means for their endpoint can
// pass a message the agent can act on instead.
export class NetlifyApiError extends Error {
  readonly status: number;
  constructor(status: number, message?: string) {
    super(message ?? `Failed to fetch API: ${status}`);
    this.name = 'NetlifyApiError';
    this.status = status;
  }
}

// Reads the `netlify login` token the CLI manages.
// DO NOT leak knowledge of CLI auth internals here, as it is not a public API and subject to change.
const readStoredToken = async (): Promise<string> => {
  let stored: StoredAPIToken;
  try {
    stored = await readStoredAPIToken();
  } catch (error) {
    throw new Error(`Couldn't read the user's Netlify login: ${error instanceof Error ? error.message : String(error)}
Fix the cause above if you can, then retry this tool.
If it can't be fixed, the user can set NETLIFY_PERSONAL_ACCESS_TOKEN in their Netlify MCP server settings instead.`);
  }
  if (stored.source !== 'none') return stored.token;
  if (stored.keychainError) {
    throw new Error(`Couldn't read the user's Netlify login from their system credential store (macOS Keychain, Windows Credential Manager, or Linux Secret Service): ${stored.keychainError.message}
Ask the user to unlock it, or to allow access if their system shows a prompt, then retry this tool.
If that doesn't work, the user can set NETLIFY_PERSONAL_ACCESS_TOKEN in their Netlify MCP server settings, or, as a last resort, set ${LEGACY_STORAGE_ENV_VAR}=1 there to keep the login in a less secure plaintext file.`);
  }
  return '';
}

export const userIsAuthenticated = async (request?: Request): Promise<boolean> => {
  try {
    const token = await getNetlifyAccessToken(request);
    if (!token) {
      return false;
    }
    // An expired token here is routine, so keep its 401 at debug.
    const response = await authenticatedFetch('/api/v1/user', {}, request, [401]);
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

// The CLI opens the browser and then polls for the ticket for up to five
// minutes, so this must outlast that poll or the CLI is killed before it
// writes the token.
const LOGIN_TIMEOUT_MS = 6 * 60 * 1000;

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
        // Codes, refresh tokens and proxy tokens also carry an accessToken; only
        // access tokens are bearers here (see token-types.ts).
        if (!isTokenTypeAllowed(decrypted, [TOKEN_TYPE.access])) {
          throw new NetlifyUnauthError('Bearer token is not an access token');
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

  token = await readStoredToken();

  if (!token) {

    const result = await runCommand('netlify login', { env: loginSpawnEnv(), timeout: LOGIN_TIMEOUT_MS });

    appendToLog(["Netlify login exit code and output", JSON.stringify(result)]);

    if (result.exitCode === 0) {
      token = await readStoredToken();
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


export const authenticatedFetch = async (urlOrPath: string, options: RequestInit = {}, incomingRequest?: Request, quietStatuses?: number[]) => {
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
      if (response.status === 401 && !incomingRequest) {
        // The local CLI path resolves auth differently: nothing to record.
        log.debug('netlify api returned 401', { method, apiPath: url.pathname });
      } else if (response.status === 401) {
        // Record it so the HTTP handler can confirm the token whatever the
        // calling tool does with this response.
        flagNetlify401(url.pathname);
        if (quietStatuses?.includes(401)) {
          log.debug('netlify api call failed (expected, caller is handling it)', { method, apiPath: url.pathname, status: 401 });
        } else {
          log.warn('netlify api call failed', { method, apiPath: url.pathname, status: 401 });
        }
      } else if (quietStatuses?.includes(response.status)) {
        log.debug('netlify api call failed (expected, caller is handling it)', { method, apiPath: url.pathname, status: response.status });
      } else {
        log.warn('netlify api call failed', { method, apiPath: url.pathname, status: response.status });
      }
    }
    return response;
  } catch (err) {
    // Network-level failure (DNS, timeout, connection reset) — no HTTP status.
    log.error('netlify api call errored', { method, apiPath: url.pathname, err });
    throw err;
  }
}


/**
 * Fetches a Netlify API endpoint and deserializes the JSON body.
 *
 * The type parameter is required: callers must name the canonical response type
 * for the endpoint they are calling (see `./api-types.ts`), so responses arrive
 * typed rather than as `any`. `T` describes the deserialized body — the casts
 * below are the deserialization boundary itself, where an untyped `JSON.parse`
 * result is given the shape the caller declared.
 *
 * Note that a `failureCallback` which returns instead of throwing, and a
 * non-JSON or empty body, both yield a `string` at runtime. Call sites relying
 * on that should include `string` in `T` and narrow.
 */
export const getAPIJSONResult = async <T>(urlOrPath: string, options: RequestInit = {}, apiInteractionOptions: APIInteractionOptions = {}, incomingRequest?: Request): Promise<T> => {

  if(!apiInteractionOptions.pagination){
    const response = await authenticatedFetch(urlOrPath, options, incomingRequest, apiInteractionOptions.quietStatuses);

    // A remote 401 is recorded on the request; don't let a failureCallback turn
    // it into a normal tool result.
    if (response.status === 401 && incomingRequest) {
      throw new NetlifyApiError(401);
    }

    if (!response.ok) {
      if(apiInteractionOptions.failureCallback){
        return apiInteractionOptions.failureCallback(response) as T;
      }
      throw new NetlifyApiError(response.status);
    }

    // Reading the body can reject if the connection drops mid-download
    // (UND_ERR_BODY_TIMEOUT / UND_ERR_SOCKET / UND_ERR_ABORTED). Surface a
    // clear message instead of leaking the raw undici error.
    let data: string;
    try {
      data = await response.text();
    } catch (err) {
      throw new Error(`Failed to read Netlify API response body: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!data) {
      return '' as T;
    }

    try{
      return JSON.parse(data) as T;
    } catch (e) {
      if (apiInteractionOptions.failureCallback) {
        return apiInteractionOptions.failureCallback(response) as T;
      }
      return data as T;
    }
  }

  const currentTime = Date.now();
  const maxDurationSeconds = 22;

  let apiResults: unknown[] = [];
  let page = 1 + (apiInteractionOptions.pageOffset || 0);

  // avoid unbounded requests
  let pageLimit = apiInteractionOptions.pageLimit || 100;
  const pageSize = apiInteractionOptions.pageSize || 100;

  while (true) {

    const url = new URL(urlOrPath, 'https://api.netlify.com')
    url.searchParams.set('page', page.toString());
    url.searchParams.set('per_page', pageSize.toString());

    const response = await authenticatedFetch(url.toString(), options, incomingRequest);

    if (!response.ok) {
      if (apiInteractionOptions.failureCallback) {
        return apiInteractionOptions.failureCallback(response) as T;
      }
      throw new NetlifyApiError(response.status);
    }

    let resultRaw: string;
    try {
      resultRaw = await response.text();
    } catch (err) {
      throw new Error(`Failed to read Netlify API response body: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!resultRaw) {
      break;
    }

    const result: unknown = JSON.parse(resultRaw);

    const lastResultTime = Date.now();
    const duration = (lastResultTime - currentTime) / 1000;
    appendToLog(`Fetched page ${page}, received ${Array.isArray(result) ? result.length : 0} sites, total ${apiResults.length}, duration: ${duration} seconds`);

    if (Array.isArray(result)) {

      apiResults.push(...result);

      appendToLog(`Fetched page ${page}, received ${result.length} sites, total ${apiResults.length}`);

      page++;

      if (result.length < pageSize || page > pageLimit || duration > maxDurationSeconds) {
        break;
      }

    } else {
      break;
    }
  }

  return apiResults as T;
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
