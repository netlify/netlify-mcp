import path from 'node:path';
import * as fs from 'node:fs/promises';
import envPaths from 'env-paths';
import { runCommand } from './cmd.ts';
import { appendToLog } from './logging.ts';
import { loginSpawnEnv } from './login-attribution.ts';
import { log } from '../../netlify/functions/mcp-server/logger.ts';
import { TokenError, verifyToken, type AccessClaims } from '../../netlify/functions/mcp-server/tokens.ts';
import { getOAuthStore } from '../../netlify/functions/mcp-server/oauth-store.ts';
import { flagAuthChallenge } from '../../netlify/functions/mcp-server/request-signals.ts';
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

// Thrown when the Netlify API returns a non-OK status. Carries the status so
// callers can tell an expected client outcome (4xx: not-found, validation) apart
// from a genuine server/network failure (5xx), and log at the right severity.
// The message is unchanged (`Failed to fetch API: <status>`) for compatibility.
export class NetlifyApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Failed to fetch API: ${status}`);
    this.name = 'NetlifyApiError';
    this.status = status;
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

const PAT_PREFIXES = ['nfu', 'nfp', 'nfo'];

/** A raw Netlify personal access token, which the MCP server accepts as-is. */
function isNetlifyPAT(bearer: string): boolean {
  return PAT_PREFIXES.some((prefix) => bearer.startsWith(prefix));
}

export type BearerCredential =
  | { kind: 'pat'; accessToken: string }
  | { kind: 'oauth'; accessToken: string; claims: AccessClaims };

/**
 * The credential behind a request's Authorization header: a Netlify PAT used
 * directly, or an access token this server issued. Anything else — an
 * authorization code, a refresh token, a proxy token, a client registration, a
 * token for another issuer — is refused here, before any Netlify API call.
 * Throws NetlifyUnauthError; never falls back to decrypting the payload.
 */
export const getBearerCredential = async (request: Request): Promise<BearerCredential> => {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new NetlifyUnauthError('no Bearer token found in Authorization header');
  }
  const bearer = authHeader.slice(7);
  if (isNetlifyPAT(bearer)) {
    return { kind: 'pat', accessToken: bearer };
  }
  try {
    const claims = await verifyToken(bearer, 'access');
    return { kind: 'oauth', accessToken: claims.accessToken, claims };
  } catch (error) {
    if (error instanceof TokenError) {
      log.warn('mcp bearer rejected', { reason: error.reason, presented: error.presented });
      throw new NetlifyUnauthError(error.reason === 'legacy_expired'
        ? 'Bearer token predates the current token format; reconnect the application'
        : 'Bearer token is invalid, expired, or not an access token');
    }
    throw error;
  }
};

/**
 * Whether the grant behind an OAuth access token is still live. Revocation
 * (RFC 7009, code replay, refresh reuse) takes effect here, on the next /mcp
 * request. A store failure propagates as OAuthStorageError so the caller
 * answers 503 rather than letting the request through unchecked.
 */
const grantIsActive = async (claims: AccessClaims): Promise<boolean> => {
  if (!claims.grant) {
    // A legacy token (no grant record) inside its sunset window.
    return true;
  }
  const found = await getOAuthStore().getGrant(claims.grant);
  if (!found || found.record.revoked) {
    log.warn('mcp bearer rejected', { reason: found ? 'grant_revoked' : 'grant_missing', grant: claims.grant });
    return false;
  }
  return true;
};

export const userIsAuthenticated = async (request?: Request): Promise<boolean> => {
  try {
    if (request) {
      const credential = await getBearerCredential(request);
      if (credential.kind === 'oauth' && !(await grantIsActive(credential.claims))) {
        return false;
      }
    }
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

  try {
    const credential = await getBearerCredential(request);
    // Raw PATs are used directly and carry no embedded identity.
    return credential.kind === 'oauth' ? credential.claims.identity ?? null : null;
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
    return (await getBearerCredential(request)).accessToken;
  }

  let token = '';

  // allow the PAT to be set just in case
  if (process.env.NETLIFY_PERSONAL_ACCESS_TOKEN) {
    return process.env.NETLIFY_PERSONAL_ACCESS_TOKEN;
  }

  token = await readTokenFromEnv();

  if (!token) {

    const result = await runCommand('netlify login', { env: loginSpawnEnv(), timeout: LOGIN_TIMEOUT_MS });

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
      if (response.status === 401) {
        // A 401 is a routine token-expiry signal, not an API failure — it's
        // expected and handled, so log it as an auth event rather than warning.
        // On remote MCP, flag the request so the HTTP handler answers with a
        // proper OAuth challenge, no matter what the calling tool does with this
        // response (throw a generic error, run a failureCallback, paginate,
        // etc.). The local CLI path (no incomingRequest) resolves auth differently.
        log.debug('netlify api returned 401', { method, apiPath: url.pathname });
        if (incomingRequest) {
          flagAuthChallenge('The Netlify access token is no longer valid');
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

    if(response.status === 401 && incomingRequest) {
      throw new NetlifyUnauthError(`Unauthedenticated request to Netlify API. ${urlOrPath}`);
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
  const maxDuration = 22000; // 22 seconds

  let apiResults: unknown[] = [];
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

      if (result.length < pageSize || page > pageLimit || duration > maxDuration) {
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
