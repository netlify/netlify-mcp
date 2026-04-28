import { authenticatedFetch } from '../../utils/api-networking.js';

// All observability endpoints live under the standard Netlify API at
// /api/v1/sites/{siteID}/observability/...
// authenticatedFetch already resolves relative paths against https://api.netlify.com.

// ---- Types ----

interface QueryFilter {
  field: string;
  op: string;
  value: string | number;
}

interface SortBy {
  field: string;
  order: 'ASC' | 'DESC';
}

interface RequestQuery {
  name: string;
  filters?: QueryFilter[];
  sort_by?: SortBy[];
  limit?: number;
  offset?: number;
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

/**
 * Parse a JSON string of filters into an array. Returns undefined if invalid.
 */
export const parseFilters = (raw?: string): QueryFilter[] | undefined => {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as QueryFilter[];
  } catch {
    return undefined;
  }
};

/**
 * Parse a JSON string of sort specs into an array. Returns undefined if invalid.
 */
export const parseSortBy = (raw?: string): SortBy[] | undefined => {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as SortBy[];
  } catch {
    return undefined;
  }
};

// ---- API Methods ----

const doPost = async (path: string, params: URLSearchParams, body: RequestPayload, incomingRequest?: Request): Promise<any> => {
  const url = `${path}${buildQueryString(params)}`;

  const response = await authenticatedFetch(url, {
    method: 'POST',
    body: JSON.stringify(body),
  }, incomingRequest);

  if (response.status === 204) {
    return { data: [], meta: {} };
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Observability API error (HTTP ${response.status}): ${text}`);
  }

  return response.json();
};

const doGet = async (path: string, params: URLSearchParams, incomingRequest?: Request): Promise<any> => {
  const url = `${path}${buildQueryString(params)}`;

  const response = await authenticatedFetch(url, {}, incomingRequest);

  if (response.status === 204) {
    return { data: [], meta: {} };
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Observability API error (HTTP ${response.status}): ${text}`);
  }

  return response.json();
};

// ---- Exported Client Functions ----

export const getCounts = async (
  siteID: string, fromTS: number, toTS: number,
  query: RequestQuery, incomingRequest?: Request
) => {
  return doPost(`/api/v1/sites/${siteID}/observability/query/counts`, timeWindowParams(fromTS, toTS), buildPayload(query), incomingRequest);
};

export const getTopK = async (
  siteID: string, fromTS: number, toTS: number,
  query: RequestQuery, incomingRequest?: Request
) => {
  return doPost(`/api/v1/sites/${siteID}/observability/query/topk`, timeWindowParams(fromTS, toTS), buildPayload(query), incomingRequest);
};

export const getTimeSeries = async (
  siteID: string, fromTS: number, toTS: number,
  interval: number | undefined, query: RequestQuery, incomingRequest?: Request
) => {
  const params = timeWindowParams(fromTS, toTS);
  if (interval && interval > 0) {
    params.set('interval', String(interval));
  }
  return doPost(`/api/v1/sites/${siteID}/observability/query/timeseries`, params, buildPayload(query), incomingRequest);
};

export const getLists = async (
  siteID: string, fromTS: number, toTS: number,
  query: RequestQuery, incomingRequest?: Request
) => {
  return doPost(`/api/v1/sites/${siteID}/observability/query/lists`, timeWindowParams(fromTS, toTS), buildPayload(query), incomingRequest);
};

export const getRequestDetail = async (
  siteID: string, requestID: string, fromTS?: number, incomingRequest?: Request
) => {
  const params = new URLSearchParams();
  if (fromTS && fromTS > 0) {
    params.set('from_ts', String(fromTS));
  }
  return doGet(`/api/v1/sites/${siteID}/observability/requests/${requestID}`, params, incomingRequest);
};

export const getAlerts = async (
  siteID: string, fromTS: number, toTS: number,
  severity?: string, incomingRequest?: Request
) => {
  const params = timeWindowParams(fromTS, toTS);
  if (severity) {
    params.set('severity', severity);
  }
  return doGet(`/api/v1/sites/${siteID}/observability/alerts`, params, incomingRequest);
};
