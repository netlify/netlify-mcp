import path from 'node:path';
import * as fs from 'node:fs/promises';
import { appendToLog } from '../../utils/logging.js';
import { type JsonSchema7Type } from 'zod-to-json-schema';
import { authenticatedFetch, getNetlifyAccessToken, unauthenticatedFetch } from '../../utils/api-networking.js';

const sdkBaseUrl = 'https://api.netlifysdk.com';
const netlifyFunctionsBaseUrl = 'https://app.netlify.com/.netlify/functions';


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

export type NetlifyExtension = {
  id: number;
  name: string;
  visibility: string;
  slug: string;
  identeerSlug: string;
  scopes: string;
  description: string;
  hostSiteId: string;
  hostSiteUrl: string;
  integrationLevel: string;
  category: string;
  author: string;
  lightLogoPath: string;
  darkLogoPath: string;
  v1Migrated: boolean;
  sdkVersion?: string;
  installedOnTeam?: boolean;
  hasIntegrationUI?: boolean;
  uiSurfaces?: string[];
  hasDataIntegration?: boolean;
  hasBuildEventHandler?: boolean;
  isOwnedByTeam?: boolean;
  isPartner?: boolean;
  details?: string;
  numInstallations?: number;

  // added internally by MCP
  siteLevelConfigurationUrl?: string;
  trpcEndpoint?: string;
  trpcProcedures?: TRPCProcedure[];
};

export type TRPCProcedure = {
  name: string;
  type: 'query' | 'mutation' | 'subscription';
  inputSchema: (JsonSchema7Type & { $schema: string }) | null;
};


export const getSiteId = async ({ projectDir }: { projectDir: string }): Promise<string> => {
  const netlifySiteStatePath = path.join(projectDir, '.netlify', 'state.json');
  const data = await fs.readFile(netlifySiteStatePath);
  const parsedData = JSON.parse(data.toString());
  return parsedData.siteId;
}


export const getSite = async ({ siteId }: { siteId: string }): Promise<NetlifySite> => {
  const res = await authenticatedFetch(`/api/v1/sites/${siteId}`);

  if (!res.ok) {
    const data = await res.json();
    throw new Error(`Failed to fetch sites, status: ${res.status}, ${data.message}`);
  }

  return await res.json();
}


export const getExtensions = async (): Promise<NetlifyExtension[]> => {
  const res = await unauthenticatedFetch(`${sdkBaseUrl}/integrations`);
  if (!res.ok) {
    throw new Error(`Failed to fetch extensions`);
  }
  return await res.json();
}



export const getExtension = async ({
  accountId,
  extensionSlug
}: {
  accountId: string;
  extensionSlug: string;
}): Promise<NetlifyExtension> => {
  const res = await authenticatedFetch(
    `${sdkBaseUrl}/${encodeURIComponent(accountId)}/integrations/${encodeURIComponent(extensionSlug)}`,
    {
      headers: {
        'netlify-token': await getNetlifyAccessToken(),
        'Api-Version': '2'
      }
    }
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch extension with slug '${extensionSlug}'`);
  }

  const extensionData: NetlifyExtension = await res.json();

  return extensionData;
}

export const changeExtensionInstallation = async ({
  shouldBeInstalled,
  accountId,
  extensionSlug
}: {
  shouldBeInstalled: boolean;
  accountId: string;
  extensionSlug: string;
}): Promise<NetlifyExtension> => {
  const extensionData = await getExtension({ accountId, extensionSlug });
  const res = await authenticatedFetch(`${netlifyFunctionsBaseUrl}/${shouldBeInstalled ? 'install' : 'uninstall'}-extension`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `_nf-auth=${await getNetlifyAccessToken()}`
    },
    body: JSON.stringify({
      teamId: accountId,
      slug: extensionSlug,
      hostSiteUrl: extensionData.hostSiteUrl
    })
  });

  if (!res.ok) {
    throw new Error(`Failed to install extension: ${extensionSlug}`);
  }

  const installExtensionData = await res.json();
  return installExtensionData;
}

const getSDKToken = async ({
  accountId,
  extensionSlug
}: {
  accountId: string;
  extensionSlug: string;
}): Promise<string> => {
  const res = await authenticatedFetch(`${sdkBaseUrl}/generate-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Version': '2',
      Cookie: `_nf-auth=${await getNetlifyAccessToken()}`
    },
    body: JSON.stringify({
      ownerId: accountId,
      integrationSlug: extensionSlug
    })
  });

  if (!res.ok) {
    const data = await res.json();
    throw new Error(`Failed to get SDK token, status: ${res.status}, ${data.message}`);
  }

  const { token } = await res.json();
  return token;
}

const callExtensionAPI = async ({
  site,
  extensionData,
  sdkToken,
  trpcProcedureName,
  trpcInput
}: {
  site: NetlifySite;
  extensionData: NetlifyExtension;
  sdkToken: string;
  trpcProcedureName: string;
  trpcInput?: any;
}): Promise<void> => {
  if (!extensionData.trpcEndpoint || extensionData.trpcProcedures?.length === 0) {
    throw new Error(`Extension "${extensionData.name}" does not have trpcEndpoint or trpcProcedures.`);
  }
  const trpcProcedure = extensionData.trpcProcedures?.find(
    (trpcProcedure) => trpcProcedure.name === trpcProcedureName
  );
  if (!trpcProcedure) {
    throw new Error(
      `Extension "${extensionData.name}" does not have TRPC procedure named "${trpcProcedureName}".`
    );
  }
  if (trpcProcedure.type === 'subscription') {
    throw new Error('TRPC procedures of type "subscription" not supported.');
  }

  const endpoint = `${extensionData.trpcEndpoint}/${trpcProcedureName}`;
  const method = trpcProcedure.type === 'query' ? 'GET' : 'POST';
  // TODO: validate TRPC input and throw an error so AI could fix it
  const body = JSON.stringify(trpcInput);

  appendToLog([
    `configure extension for extensionId: ${extensionData.id}, ` +
    `extensionSlug: ${extensionData.slug}, siteId: ${site.id}, ` +
    `accountId: ${site.account_id}, userId: ${site.user_id}, ` +
    `trpcProcedureName: ${trpcProcedureName}, trpcInput: ${body}`
  ]);

  const res = await fetch(`${extensionData.hostSiteUrl}${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'nf-uiext-extension-id': String(extensionData.id),
      'nf-uiext-extension-slug': extensionData.slug,
      'nf-uiext-netlify-token': sdkToken,
      'nf-uiext-site-id': site.id,
      'nf-uiext-team-id': site.account_id,
      'nf-uiext-user-id': site.user_id
    },
    body: body
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Failed to configure extension, status: ${res.status}, ${data.message}`);
  }
  appendToLog([`successfully invoked extension API, response:`, data]);

  return data;
}
