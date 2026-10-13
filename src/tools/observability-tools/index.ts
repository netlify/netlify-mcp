import { z } from 'zod';
import type { DomainTool } from '../types.js';
import {
  getCounts,
  getTopK,
  getTimeSeries,
  getLists,
  getRequestDetail,
  parseFilters,
  parseSortBy,
} from './api-client.js';

// ---- Shared descriptions ----

const filtersDescription = `Optional JSON array of filter objects. Each filter has: "field" (StatusCode, URL, Method, UserAgent, ContentType, BlockReason, CacheStatus, EdgeFunctionName, FunctionName, LogText, RequestId, ClientAddress, ConnectionAddress, Branch), "op" (=, !=, >, <, >=, <=), and "value". Example: [{"field":"StatusCode","op":">=","value":500}]`;

const sortByDescription = `Optional JSON array of sort objects. Each has "field" (Count, ErrorCount, Bandwidth, P50, P75, P90, P99, Key, FunctionInvocations, EdgeFunctionInvocations) and "order" (ASC or DESC). Default: [{"field":"Count","order":"DESC"}]`;

// ---- Tool: get-counts ----

const getCountsSchema = z.object({
  siteId: z.string().describe('Netlify site ID'),
  from_ts: z.number().describe('Start timestamp in milliseconds since Unix epoch'),
  to_ts: z.number().describe('End timestamp in milliseconds since Unix epoch'),
  query_name: z.string().describe('Type of count: status_codes, content_types, user_agent_categories, methods, block_reasons, cache_status, function_names, edge_function_names'),
  filters: z.string().optional().describe(filtersDescription),
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
      filters: parseFilters(filters),
    }, request);
    return JSON.stringify(result);
  },
};

// ---- Tool: get-topk ----

const getTopKSchema = z.object({
  siteId: z.string().describe('Netlify site ID'),
  from_ts: z.number().describe('Start timestamp in milliseconds since Unix epoch'),
  to_ts: z.number().describe('End timestamp in milliseconds since Unix epoch'),
  query_name: z.string().describe('Breakdown type: user_agents, user_agent_categories, urls, urls_with_query, status_codes, referrers, functions, edge_functions, content_types, client_address, client_countries, connection_address'),
  limit: z.number().optional().describe('Max items to return (default 10)'),
  offset: z.number().optional().describe('Pagination offset (default 0)'),
  filters: z.string().optional().describe(filtersDescription),
  sort_by: z.string().optional().describe(sortByDescription),
});

const getTopKDomainTool: DomainTool<typeof getTopKSchema> = {
  domain: 'observability',
  operation: 'get-topk',
  description:
    "Rank the top values of one dimension of a project's (site's) edge requests over a time window, such as the most-requested URLs, user agents, referrers, client IPs, countries, or functions. Supports filtering, sorting by count, errors, bandwidth or latency percentiles, and pagination.",
  inputSchema: getTopKSchema,
  toolAnnotations: { readOnlyHint: true },
  cb: async ({ siteId, from_ts, to_ts, query_name, limit, offset, filters, sort_by }, { request }) => {
    const result = await getTopK(siteId, from_ts, to_ts, {
      name: query_name,
      limit: limit || 10,
      offset: offset || 0,
      filters: parseFilters(filters),
      sort_by: parseSortBy(sort_by),
    }, request);
    return JSON.stringify(result);
  },
};

// ---- Tool: get-timeseries ----

const getTimeSeriesSchema = z.object({
  siteId: z.string().describe('Netlify site ID'),
  from_ts: z.number().describe('Start timestamp in milliseconds since Unix epoch'),
  to_ts: z.number().describe('End timestamp in milliseconds since Unix epoch'),
  query_name: z.string().describe('Metric type: edge_requests_count, edge_requests_duration_percentiles, edge_requests_bandwidth'),
  interval: z.number().optional().describe('Bucket interval in milliseconds. If not set, the API picks a default based on the time window.'),
  filters: z.string().optional().describe(filtersDescription),
});

const getTimeSeriesDomainTool: DomainTool<typeof getTimeSeriesSchema> = {
  domain: 'observability',
  operation: 'get-timeseries',
  description:
    "Get a time series of a project's (site's) edge traffic over a window: request counts, latency percentiles, or bandwidth, in buckets. Use it to see when a spike, slowdown, or error burst started and ended.",
  inputSchema: getTimeSeriesSchema,
  toolAnnotations: { readOnlyHint: true },
  cb: async ({ siteId, from_ts, to_ts, query_name, interval, filters }, { request }) => {
    const result = await getTimeSeries(siteId, from_ts, to_ts, interval, {
      name: query_name,
      filters: parseFilters(filters),
    }, request);
    return JSON.stringify(result);
  },
};

// ---- Tool: get-request-logs ----

const getRequestLogsSchema = z.object({
  siteId: z.string().describe('Netlify site ID'),
  from_ts: z.number().describe('Start timestamp in milliseconds since Unix epoch'),
  to_ts: z.number().describe('End timestamp in milliseconds since Unix epoch'),
  page: z.number().optional().describe('Page number (1-based, default 1)'),
  per_page: z.number().optional().describe('Items per page (default 20)'),
  filters: z.string().optional().describe(filtersDescription),
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
      filters: parseFilters(filters),
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
