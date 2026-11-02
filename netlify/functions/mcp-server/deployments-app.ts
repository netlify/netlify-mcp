import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getAPIJSONResult } from '../../../src/utils/api-networking.ts';
import type { NetlifyDeployResponse } from '../../../src/utils/api-types.ts';
import { deploymentsHtml } from './deployments-html.ts';

const RESOURCE_URI = 'ui://netlify/deployments-v6.html';
const MIME_TYPE = 'text/html;profile=mcp-app';
const ACTIVE_STATES = new Set([
  'new', 'accepted', 'enqueued', 'building', 'uploading', 'uploaded',
  'preparing', 'prepared', 'processing', 'retrying',
]);
const inputSchema = {
  siteId: z.string().uuid().describe('Netlify site ID. Use get-projects to find it by project name.'),
  deployId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional()
    .describe('Optional deploy ID to show just that deploy instead of the five most recent deploys.'),
};
const annotations = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
};

function webUrl(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? '');
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href : null;
  } catch {
    return null;
  }
}

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

  const readDeployments = async ({ siteId, deployId }: { siteId: string; deployId?: string }) => {
    const path = `/api/v1/sites/${encodeURIComponent(siteId)}/deploys`;
    const raw = deployId
      ? [await getAPIJSONResult<NetlifyDeployResponse>(`${path}/${encodeURIComponent(deployId)}`, {}, {}, request)]
      : await getAPIJSONResult<NetlifyDeployResponse[]>(`${path}?per_page=5`, {}, {}, request);
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
      commit: deploy.commit_ref ?? '',
      commitUrl: webUrl(deploy.commit_url),
      createdAt: deploy.created_at ?? '',
      error: deploy.error_message ?? '',
      adminUrl: `https://app.netlify.com/sites/${siteId}/deploys/${encodeURIComponent(deploy.id!)}`,
      // Use the immutable deploy URL, never the site's current production URL.
      deployUrl: deploy.state === 'ready' && !deploy.skipped
        ? deployPermalink(deploy) : null,
    }));
    const structuredContent = {
      siteId, deployId: deployId ?? null, deploys,
      hasActiveDeploys: deploys.some(deploy => ACTIVE_STATES.has(deploy.state)),
    };
    return {
      structuredContent,
      content: [{ type: 'text' as const, text: deploys.length
        ? deploys.map(deploy => [
          `${deploy.name}: ${deploy.state} (${deploy.id})`,
          [deploy.branch, deploy.context, deploy.commit].filter(Boolean).join(' · '),
          deploy.error, deploy.adminUrl, deploy.deployUrl,
        ].filter(Boolean).join('\n')).join('\n\n')
        : 'No deploys found for this project.' }],
    };
  };

  server.registerTool('netlify-open-deployments', {
    title: 'Open Netlify deployments',
    description: 'Show an interactive card of the five most recent deploys for a Netlify project, or one specific deploy. Includes live status, branch, commit, errors, and links. Read-only; does not start a deploy. Also returns text for clients without UI support.',
    inputSchema, annotations,
    _meta: { ui: { resourceUri: RESOURCE_URI } },
  }, readDeployments);

  // Refresh without asking the host to mount another card.
  server.registerTool('netlify-refresh-deployments', {
    description: 'Refresh the deployment card with current deploy status and links. Read-only.',
    inputSchema, annotations,
    _meta: { ui: { visibility: ['app'] } },
  }, readDeployments);
}
