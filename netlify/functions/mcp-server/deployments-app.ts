import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getAPIJSONResult } from '../../../src/utils/api-networking.ts';
import type { NetlifyDeployResponse, NetlifySiteResponse } from '../../../src/utils/api-types.ts';
import { deploymentsHtml } from './deployments-html.ts';

const RESOURCE_URI = 'ui://netlify/deployments-v7.html';
const MIME_TYPE = 'text/html;profile=mcp-app';
const ACTIVE_STATES = new Set([
  'new', 'accepted', 'enqueued', 'building', 'uploading', 'uploaded',
  'preparing', 'prepared', 'processing', 'retrying',
]);
const inputSchema = {
  siteId: z.string().uuid().describe('Netlify site ID. Use get-projects to find it by project name.'),
  deployId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional()
    .describe('Optional deploy ID to show just that deploy instead of the five most recent deploys.'),
  status: z.enum(['error', 'ready', 'enqueued', 'pending_review', 'accepted', 'rejected']).optional()
    .describe('Filter deployment status. Applies to the project list, not a specific deploy.'),
  from: z.number().int().nonnegative().optional().describe('Start of the creation-time range, Unix seconds. Supply with to.'),
  to: z.number().int().nonnegative().optional().describe('End of the creation-time range, Unix seconds. Supply with from.'),
};
type DeploymentsInput = z.infer<z.ZodObject<typeof inputSchema>>;
const annotations = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
};

function deployPermalink(deploy: NetlifyDeployResponse): string | null {
  // deploy_ssl_url/deploy_url can be moving branch or preview aliases.
  if (!deploy.id || !deploy.name || !/^[a-z0-9-]+$/i.test(deploy.id)
      || !/^[a-z0-9-]+$/i.test(deploy.name)) return null;
  return `https://${deploy.id}--${deploy.name}.netlify.app/`;
}

export function registerDeploymentsApp(server: McpServer, request: Request): void {
  server.registerResource('netlify-deployments', RESOURCE_URI, { mimeType: MIME_TYPE }, async () => ({
    contents: [{
      uri: RESOURCE_URI, mimeType: MIME_TYPE, text: deploymentsHtml,
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
    }],
  }));

  const readDeployments = async ({ siteId, deployId, status, from, to }: DeploymentsInput, includeProject = false) => {
    if ((from === undefined) !== (to === undefined) || (from !== undefined && from > to!)) {
      throw new Error('Supply both from and to, with from before to.');
    }
    if (deployId && (status || from !== undefined)) throw new Error('Filters apply to the project list, not a specific deploy.');
    const query = new URLSearchParams({ per_page: '5' });
    if (status) query.set('state', status);
    if (from !== undefined) { query.set('from', String(from)); query.set('to', String(to)); }
    const path = `/api/v1/sites/${encodeURIComponent(siteId)}/deploys`;
    const raw = deployId
      ? [await getAPIJSONResult<NetlifyDeployResponse>(`${path}/${encodeURIComponent(deployId)}`, {}, {}, request)]
      : await getAPIJSONResult<NetlifyDeployResponse[]>(`${path}?${query}`, {}, {}, request);
    if (!Array.isArray(raw) || raw.some(deploy => !deploy?.id || !deploy.state)) {
      throw new Error('Netlify returned an invalid deployment response. Please retry.');
    }

    // Only send display fields: the full API response includes build configuration and tokens.
    const deploys = raw.slice(0, 5).map(deploy => ({
      id: deploy.id!,
      name: deploy.name ?? siteId,
      state: deploy.skipped ? 'skipped' : deploy.state!,
      title: deploy.title ?? '',
      branch: deploy.branch ?? '',
      context: deploy.context ?? '',
      createdAt: deploy.created_at ?? '',
      error: deploy.error_message ?? '',
      adminUrl: `https://app.netlify.com/sites/${siteId}/deploys/${encodeURIComponent(deploy.id!)}`,
      // Use the immutable deploy URL, never the site's current production URL.
      deployUrl: deploy.state === 'ready' && !deploy.skipped
        ? deployPermalink(deploy) : null,
    }));
    // Team context is read once when opening, not on every polling request.
    const site = includeProject
      ? await getAPIJSONResult<NetlifySiteResponse>(`/api/v1/sites/${siteId}`, {}, {}, request) : null;
    const structuredContent = {
      siteId, deployId: deployId ?? null, deploys,
      filters: { status: status ?? null, from: from ?? null, to: to ?? null },
      ...(site ? { project: { name: site.name ?? siteId, teamName: site.account_name ?? '',
        teamUrl: site.account_slug ? `https://app.netlify.com/teams/${encodeURIComponent(site.account_slug)}/overview` : null } } : {}),
      hasActiveDeploys: deploys.some(deploy => ACTIVE_STATES.has(deploy.state)),
    };
    return {
      structuredContent,
      content: [{ type: 'text' as const, text: deploys.length
        ? deploys.map(deploy => [
          `${deploy.name}: ${deploy.state} (${deploy.id})`,
          [deploy.branch, deploy.context].filter(Boolean).join(' · '),
          deploy.error, deploy.adminUrl, deploy.deployUrl,
        ].filter(Boolean).join('\n')).join('\n\n')
        : 'No deploys found for this project.' }],
    };
  };

  server.registerTool('netlify-open-deployments', {
    title: 'Netlify Deployments',
    description: 'Show an interactive card of the five most recent matching deploys for a Netlify project, or one specific deploy. Filter by status and creation time. Includes team, live status, branch, errors, and links. Read-only; does not start a deploy. Also returns text for clients without UI support.',
    inputSchema, annotations,
    _meta: { ui: { resourceUri: RESOURCE_URI } },
  }, args => readDeployments(args, true));

  // Refresh without asking the host to mount another card.
  server.registerTool('netlify-refresh-deployments', {
    description: 'Refresh the deployment card with current deploy status and links. Read-only.',
    inputSchema, annotations,
    _meta: { ui: { visibility: ['app'] } },
  }, args => readDeployments(args));
}
