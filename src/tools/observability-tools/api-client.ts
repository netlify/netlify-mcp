import { authenticatedFetch, NetlifyApiError, NetlifyUnauthError, userIsAuthenticated } from '../../utils/api-networking.js';

// All observability endpoints live under the standard Netlify API at
// /api/v1/sites/{siteID}/observability/...
// authenticatedFetch already resolves relative paths against https://api.netlify.com.

// ---- Request types ----

export const COUNT_QUERY_NAMES = [
  'status_codes', 'content_types', 'user_agent_categories', 'methods',
  'block_reasons', 'cache_status', 'function_names', 'edge_function_names',
] as const;

export const TOPK_QUERY_NAMES = [
  'user_agents', 'user_agent_categories', 'urls', 'urls_with_query', 'status_codes',
  'referrers', 'functions', 'edge_functions', 'content_types', 'client_address',
  'client_countries', 'connection_address',
] as const;

export const TIMESERIES_QUERY_NAMES = [
  'edge_requests_count', 'edge_requests_duration_percentiles', 'edge_requests_bandwidth',
] as const;

export const FILTER_FIELDS = [
  'StatusCode', 'URL', 'Method', 'UserAgent', 'UserAgentCategory', 'ContentType',
  'BlockReason', 'CacheStatus', 'EdgeFunctionName', 'FunctionName', 'ImageCDNName',
  'AIGatewayName', 'LogText', 'RequestId', 'ClientAddress', 'ConnectionAddress', 'Branch',
] as const;

export const FILTER_OPS = ['=', '!=', '>', '<', '>=', '<='] as const;

export const SORT_FIELDS = [
  'Count', 'ErrorCount', 'Bandwidth', 'FunctionInvocations', 'EdgeFunctionInvocations',
  'ImageCDNInvocations', 'P50', 'P75', 'P90', 'P99', 'Key',
] as const;

export interface QueryFilter {
  field: typeof FILTER_FIELDS[number];
  op: typeof FILTER_OPS[number];
  value: string | number;
}

export interface SortBy {
  field: typeof SORT_FIELDS[number];
  order: 'ASC' | 'DESC';
}

interface RequestQuery {
  name: string;
  filters?: QueryFilter[];
  sort_by?: SortBy[];
  page?: number;
  per_page?: number;
}

interface RequestPayload {
  data: Array<{
    attributes: {
      queries: RequestQuery[];
    };
  }>;
}

// ---- Response types ----

interface QueryResponse<Attributes, Meta> {
  data: Array<{ type: string; attributes: Attributes }>;
  meta: { responses: Meta[] };
}

interface WindowMeta {
  from: number;
  to: number;
  type: string;
  limited?: boolean;
}

interface PageMeta extends WindowMeta {
  page: number;
  per_page: number;
  has_next_page: boolean;
}

export type CountsResponse = QueryResponse<{
  items: Array<{ key: string | number; count: number }>;
}, WindowMeta>;

export type TopKResponse = QueryResponse<{
  items: Array<{
    key: string;
    count: number;
    error_count: number;
    bandwidth: number;
    function_invocations: number;
    edge_function_invocations: number;
    image_cdn_invocations: number;
    ai_gateway_invocations: number;
    p50: number;
    p75: number;
    p90: number;
    p99: number;
  }>;
}, PageMeta>;

export type TimeSeriesResponse = QueryResponse<{
  series: Array<{ group_tags: string[] }>;
  times: number[];
  values: number[][];
}, WindowMeta & { interval: number }>;

export type RequestLogsResponse = QueryResponse<{
  list: Array<{
    request_id: string;
    timestamp: string;
    logs: Array<{
      body: string;
      timestamp: string;
      severity: string;
      executionId: string;
      attributes: Record<string, string>;
    }>;
    method: string;
    url: string;
    has_function_invocation: boolean;
    has_edge_function_invocation: boolean;
    has_image_cdn_invocation: boolean;
    has_ai_gateway_invocation: boolean;
    has_server_invocation: boolean;
    status_code: number;
    duration_ns: number;
    edge_cache_result: string;
    durable_cache_result: string;
  }> | null;
}, PageMeta>;

export interface RequestDetailResponse {
  url: string;
  method: string;
  status_code: number;
  client: {
    address: string;
    user_agent: string;
    user_agent_category: string;
    user_agent_sub_category: string;
    referrer: string;
    country: string;
    region: string;
    longitude?: number;
    latitude?: number;
  };
  timestamp?: number;
  duration_ns: number;
  content_type?: string;
  response_size_b?: number;
  cache_status: {
    hit: boolean;
    caches: {
      durable?: { hit: boolean; stored: boolean; ttl: number; stale: boolean; swr: boolean };
      edge?: { hit: boolean; stale: boolean };
    };
  };
  operations: Array<{
    timestamp?: number;
    duration_ns: number;
    type: string;
    name?: string;
    logs?: Array<{ body?: string; timestamp?: number; severity?: string; attributes?: Record<string, string> }>;
    metadata?: unknown;
  }>;
}

// ---- Helpers ----

const buildPayload = (query: RequestQuery): RequestPayload => ({
  data: [{
    attributes: {
      queries: [query],
    },
  }],
});

const buildQueryString = (params: URLSearchParams): string => {
  const qs = params.toString();
  return qs ? `?${qs}` : '';
};

const timeWindowParams = (fromTS: number, toTS: number): URLSearchParams => {
  const params = new URLSearchParams();
  params.set('from_ts', String(fromTS));
  params.set('to_ts', String(toTS));
  return params;
};

// ---- API Methods ----

// The observability API answers 401 with this message when the requested window
// reaches further back than the team plan's log retention. It is a plan limit,
// not an auth failure: by the time a tool runs, the MCP handler has already
// verified the token with a /user lookup.
export const OUT_OF_BOUNDS_MSG = 'requested window out of bounds';

const OUT_OF_BOUNDS_GUIDANCE =
  'The entire requested time window is older than this team\'s log retention (24 hours on free, 7 days on pro and business, 30 days on enterprise), so that data is no longer available. A query needs a window whose end (to_ts) falls within retention; a single request older than retention can\'t be retrieved.';

const MAX_DETAIL_LENGTH = 500;

const capDetail = (detail: string): string =>
  detail.length > MAX_DETAIL_LENGTH ? `${detail.slice(0, MAX_DETAIL_LENGTH)}...` : detail;

// The API's own message: the JSON `msg` when there is one, else the raw body so
// the agent still sees what went wrong.
const parseApiMessage = (text: string): string | undefined => {
  try {
    const body = JSON.parse(text);
    if (typeof body?.msg === 'string') return capDetail(body.msg);
  } catch {
    // not JSON; fall through to the raw text
  }
  const raw = text.trim();
  return raw ? capDetail(raw) : undefined;
};

const isOutOfBounds = (text: string): boolean =>
  !!parseApiMessage(text)?.toLowerCase().includes(OUT_OF_BOUNDS_MSG);

// Turn a non-OK observability response into the right error class, so the tool
// dispatcher can tell an expected client outcome (4xx, logged at warn) from a
// real failure (5xx, logged at error), and so the agent gets a message it can
// act on rather than a bare status.
export const classifyFailure = (status: number, text: string): Error => {
  if (status === 401 && isOutOfBounds(text)) {
    return new NetlifyApiError(401, `${OUT_OF_BOUNDS_MSG}: ${OUT_OF_BOUNDS_GUIDANCE}`);
  }

  const msg = parseApiMessage(text);
  return new NetlifyApiError(status, `Observability API error (HTTP ${status})${msg ? `: ${msg}` : ''}`);
};

// A body read can fail when the connection drops mid-download. The status is
// still known, so classify on it with an empty body rather than losing the
// classification to a body-read error.
const readBodyText = async (response: Response): Promise<string> => {
  try {
    return await response.text();
  } catch {
    return '';
  }
};

const request = async <T>(path: string, params: URLSearchParams, init: RequestInit, incomingRequest?: Request): Promise<T> => {
  const response = await authenticatedFetch(`${path}${buildQueryString(params)}`, init, incomingRequest, { callerHandles401: true });

  if (!response.ok) {
    const text = await readBodyText(response);
    // This API also answers 401 for non-auth reasons, so a 401 alone doesn't mean
    // the token failed. Unless it's the retention limit, re-check with /user in
    // case the token was revoked mid-request; userIsAuthenticated flags the
    // OAuth challenge if so.
    if (response.status === 401 && !isOutOfBounds(text) && !(await userIsAuthenticated(incomingRequest))) {
      throw new NetlifyUnauthError('Unauthenticated request to Netlify observability API');
    }
    throw classifyFailure(response.status, text);
  }

  return await response.json() as T;
};

const queryPath = (siteID: string, query: string) =>
  `/api/v1/sites/${encodeURIComponent(siteID)}/observability/query/${query}`;

const post = <T>(path: string, params: URLSearchParams, query: RequestQuery, incomingRequest?: Request) =>
  request<T>(path, params, { method: 'POST', body: JSON.stringify(buildPayload(query)) }, incomingRequest);

// ---- Exported Client Functions ----

export const getCounts = (
  siteID: string, fromTS: number, toTS: number,
  query: RequestQuery, incomingRequest?: Request
) => post<CountsResponse>(queryPath(siteID, 'counts'), timeWindowParams(fromTS, toTS), query, incomingRequest);

export const getTopK = (
  siteID: string, fromTS: number, toTS: number,
  query: RequestQuery, incomingRequest?: Request
) => post<TopKResponse>(queryPath(siteID, 'topk'), timeWindowParams(fromTS, toTS), query, incomingRequest);

export const getTimeSeries = (
  siteID: string, fromTS: number, toTS: number,
  interval: number | undefined, query: RequestQuery, incomingRequest?: Request
) => {
  const params = timeWindowParams(fromTS, toTS);
  if (interval && interval > 0) {
    params.set('interval', String(interval));
  }
  return post<TimeSeriesResponse>(queryPath(siteID, 'timeseries'), params, query, incomingRequest);
};

export const getLists = (
  siteID: string, fromTS: number, toTS: number,
  query: RequestQuery, incomingRequest?: Request
) => post<RequestLogsResponse>(queryPath(siteID, 'lists'), timeWindowParams(fromTS, toTS), query, incomingRequest);

export const getRequestDetail = (
  siteID: string, requestID: string, fromTS: number, toTS: number, incomingRequest?: Request
) => request<RequestDetailResponse>(
  `/api/v1/sites/${encodeURIComponent(siteID)}/observability/requests/${encodeURIComponent(requestID)}`,
  timeWindowParams(fromTS, toTS), {}, incomingRequest,
);
