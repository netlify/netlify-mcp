import { z } from 'zod';
import type { DomainTool } from '../types.js';
import {
  getCounts,
  getTopK,
  getTimeSeries,
  getLists,
  getRequestDetail,
  getAlerts,
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
  from_ts: z.number().optional().describe('Optional start timestamp in milliseconds for time context'),
});

const getRequestDetailDomainTool: DomainTool<typeof getRequestDetailSchema> = {
  domain: 'observability',
  operation: 'get-request-detail',
  inputSchema: getRequestDetailSchema,
  toolAnnotations: { readOnlyHint: true },
  cb: async ({ siteId, request_id, from_ts }, { request }) => {
    const result = await getRequestDetail(siteId, request_id, from_ts, request);
    return JSON.stringify(result);
  },
};

// ---- Tool: get-alerts ----

const getAlertsSchema = z.object({
  siteId: z.string().describe('Netlify site ID'),
  from_ts: z.number().describe('Start timestamp in milliseconds since Unix epoch'),
  to_ts: z.number().describe('End timestamp in milliseconds since Unix epoch'),
  severity: z.string().optional().describe("Comma-separated severity filter (e.g. 'critical,high')"),
});

const getAlertsDomainTool: DomainTool<typeof getAlertsSchema> = {
  domain: 'observability',
  operation: 'get-alerts',
  inputSchema: getAlertsSchema,
  toolAnnotations: { readOnlyHint: true },
  cb: async ({ siteId, from_ts, to_ts, severity }, { request }) => {
    const result = await getAlerts(siteId, from_ts, to_ts, severity, request);
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
  getAlertsDomainTool,
];
