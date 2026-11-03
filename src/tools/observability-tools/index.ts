import { z } from 'zod';
import type { DomainTool } from '../types.js';
import {
  getCounts,
  getTopK,
  getTimeSeries,
  getLists,
  getRequestDetail,
  COUNT_QUERY_NAMES,
  TOPK_QUERY_NAMES,
  TIMESERIES_QUERY_NAMES,
  FILTER_FIELDS,
  FILTER_OPS,
  SORT_FIELDS,
} from './api-client.js';

// ---- Shared descriptions ----

const filtersSchema = z.array(z.object({
  field: z.enum(FILTER_FIELDS),
  op: z.enum(FILTER_OPS),
  value: z.union([z.string(), z.number()]).describe('A number for StatusCode, a string for everything else'),
})).optional().describe('Filters to narrow the requests. Filters on different fields are ANDed; filters on the same field are ORed. Range operators (>, <, >=, <=) only apply to StatusCode. URL, UserAgent, RequestId, ClientAddress, ConnectionAddress and LogText only accept "=", and LogText matches text within function log lines. Example: [{"field":"StatusCode","op":">=","value":500}]');

const sortBySchema = z.array(z.object({
  field: z.enum(SORT_FIELDS),
  order: z.enum(['ASC', 'DESC']),
})).optional().describe('Sort order. Default: [{"field":"Count","order":"DESC"}]');

const fromTsDescription = 'Start timestamp in milliseconds since Unix epoch (not seconds). How far back data goes depends on the team plan (typically 24 hours on free, 7 days on pro and business, 30 days on enterprise). An older start is clamped to that limit, and a window entirely before it fails with "requested window out of bounds".';

const toTsDescription = 'End timestamp in milliseconds since Unix epoch (not seconds)';

// ---- Tool: get-counts ----

const getCountsSchema = z.object({
  siteId: z.string().describe('Netlify site ID'),
  from_ts: z.number().describe(fromTsDescription),
  to_ts: z.number().describe(toTsDescription),
  query_name: z.enum(COUNT_QUERY_NAMES).describe('Which dimension to count requests by'),
  filters: filtersSchema,
});

const getCountsDomainTool: DomainTool<typeof getCountsSchema> = {
  domain: 'observability',
  operation: 'get-counts',
  description:
    "Count a project's (site's) edge requests over a time window, grouped by one dimension such as status code, content type, cache status, HTTP method, or block reason. Use it for a quick breakdown like how many requests were 5xx or blocked.",
  inputSchema: getCountsSchema,
  toolAnnotations: { readOnlyHint: true },
  cb: async ({ siteId, from_ts, to_ts, query_name, filters }, { request }) => {
    const result = await getCounts(siteId, from_ts, to_ts, {
      name: query_name,
      filters,
    }, request);
    return JSON.stringify(result);
  },
};

// ---- Tool: get-topk ----

const getTopKSchema = z.object({
  siteId: z.string().describe('Netlify site ID'),
  from_ts: z.number().describe(fromTsDescription),
  to_ts: z.number().describe(toTsDescription),
  query_name: z.enum(TOPK_QUERY_NAMES).describe('Which dimension to rank'),
  page: z.number().optional().describe('Page number (1-based, default 1)'),
  per_page: z.number().optional().describe('Items per page (default 10)'),
  filters: filtersSchema,
  sort_by: sortBySchema,
});

const getTopKDomainTool: DomainTool<typeof getTopKSchema> = {
  domain: 'observability',
  operation: 'get-topk',
  description:
    "Rank the top values of one dimension of a project's (site's) edge requests over a time window, such as the most-requested URLs, user agents, referrers, client IPs, countries, or functions. Supports filtering, sorting by count, errors, bandwidth or latency percentiles, and pagination. Latency percentiles (p50, p75, p90, p99) are in nanoseconds and bandwidth is in bytes.",
  inputSchema: getTopKSchema,
  toolAnnotations: { readOnlyHint: true },
  cb: async ({ siteId, from_ts, to_ts, query_name, page, per_page, filters, sort_by }, { request }) => {
    const result = await getTopK(siteId, from_ts, to_ts, {
      name: query_name,
      page: page || 1,
      per_page: per_page || 10,
      filters,
      sort_by,
    }, request);
    return JSON.stringify(result);
  },
};

// ---- Tool: get-timeseries ----

const getTimeSeriesSchema = z.object({
  siteId: z.string().describe('Netlify site ID'),
  from_ts: z.number().describe(fromTsDescription),
  to_ts: z.number().describe(toTsDescription),
  query_name: z.enum(TIMESERIES_QUERY_NAMES).describe('Which metric to chart'),
  interval: z.number().optional().describe('Bucket interval in milliseconds. If not set, the API picks a default based on the time window.'),
  filters: filtersSchema,
});

const getTimeSeriesDomainTool: DomainTool<typeof getTimeSeriesSchema> = {
  domain: 'observability',
  operation: 'get-timeseries',
  description:
    "Get a time series of a project's (site's) edge traffic over a window: request counts, latency percentiles, or bandwidth, in buckets. Use it to see when a spike, slowdown, or error burst started and ended. Latency values are in nanoseconds.",
  inputSchema: getTimeSeriesSchema,
  toolAnnotations: { readOnlyHint: true },
  cb: async ({ siteId, from_ts, to_ts, query_name, interval, filters }, { request }) => {
    const result = await getTimeSeries(siteId, from_ts, to_ts, interval, {
      name: query_name,
      filters,
    }, request);
    return JSON.stringify(result);
  },
};

// ---- Tool: get-request-logs ----

const getRequestLogsSchema = z.object({
  siteId: z.string().describe('Netlify site ID'),
  from_ts: z.number().describe(fromTsDescription),
  to_ts: z.number().describe(toTsDescription),
  page: z.number().optional().describe('Page number (1-based, default 1)'),
  per_page: z.number().optional().describe('Items per page (default 20)'),
  filters: filtersSchema,
});

const getRequestLogsDomainTool: DomainTool<typeof getRequestLogsSchema> = {
  domain: 'observability',
  operation: 'get-request-logs',
  description:
    "List individual edge request log entries for a project (site) over a time window, paginated. Filter by status code, URL, request id, client address and more to narrow down to the requests of interest; each entry's request id can be used to fetch that request's full detail.",
  inputSchema: getRequestLogsSchema,
  toolAnnotations: { readOnlyHint: true },
  cb: async ({ siteId, from_ts, to_ts, page, per_page, filters }, { request }) => {
    const result = await getLists(siteId, from_ts, to_ts, {
      name: 'edge_requests_logs',
      page: page || 1,
      per_page: per_page || 20,
      filters,
    }, request);
    return JSON.stringify(result);
  },
};

// ---- Tool: get-request-detail ----

const getRequestDetailSchema = z.object({
  siteId: z.string().describe('Netlify site ID'),
  request_id: z.string().describe('Request ID (ULID format)'),
  from_ts: z.number().describe('Start timestamp in milliseconds since Unix epoch. Must bracket the request (e.g. a minute before it).'),
  to_ts: z.number().describe('End timestamp in milliseconds since Unix epoch. Must bracket the request (e.g. a minute after it).'),
});

const getRequestDetailDomainTool: DomainTool<typeof getRequestDetailSchema> = {
  domain: 'observability',
  operation: 'get-request-detail',
  description:
    "Get the full record of one edge request to a project (site) by its request id. The time window must bracket when the request happened, e.g. a minute either side.",
  inputSchema: getRequestDetailSchema,
  toolAnnotations: { readOnlyHint: true },
  cb: async ({ siteId, request_id, from_ts, to_ts }, { request }) => {
    const result = await getRequestDetail(siteId, request_id, from_ts, to_ts, request);
    return JSON.stringify(result);
  },
};

// ---- Export all tools ----

export const observabilityDomainTools = [
  getCountsDomainTool,
  getTopKDomainTool,
  getTimeSeriesDomainTool,
  getRequestLogsDomainTool,
  getRequestDetailDomainTool,
];
