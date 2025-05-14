import path from 'node:path';
import * as fs from 'node:fs/promises';
import envPaths from 'env-paths';
import { runCommand } from './cmd.js';
import { appendToLog } from './logging.js';
import { type JsonSchema7Type } from 'zod-to-json-schema';


const netlifyApiUrl = 'https://api.netlify.com';
const sdkBaseUrl = 'https://api.netlifysdk.com';
const netlifyFunctionsBaseUrl = 'https://app.netlify.com/.netlify/functions';

const getAuthTokenMsg = `
You're not logged into Netlify on this computer. Use the netlify cli to login. \`netlify login\`
If you don't have the netlify cli installed, install it by running "npm i -g netlify-cli",
`

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

export const getNetlifyAccessToken = async (): Promise<string> => {
  let token = '';

  // allow the PAT to be set just in case
  if (process.env.NETLIFY_PERSONAL_ACCESS_TOKEN) {
    return process.env.NETLIFY_PERSONAL_ACCESS_TOKEN;
  }

  token = await readTokenFromEnv();

  if (!token) {

    const result = await runCommand('netlify login', { env: process.env });

    appendToLog(["Netlify login exit code and output", JSON.stringify(result)]);

    if (result.exitCode === 0) {
      token = await readTokenFromEnv();
    }

    if (!token) {
      throw new Error(getAuthTokenMsg);
    }
  }
  return token;
}

export const unauthenticatedFetch = async (url: string, options: RequestInit = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      'user-agent': 'netlify-mcp',
      ...(options.headers || {})
    },
  });
  return response;
}


export const authenticatedFetch = async (url: string, options: RequestInit = {}) => {
  const token = await getNetlifyAccessToken();
  return unauthenticatedFetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {})
    },
  });
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
  const res = await authenticatedFetch(`${netlifyApiUrl}/api/v1/sites/${siteId}`);

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

export const installExtension = async ({
  accountId,
  extensionSlug
}: {
  accountId: string;
  extensionSlug: string;
}): Promise<NetlifyExtension> => {
  const extensionData = await getExtension({ accountId, extensionSlug });
  const res = await authenticatedFetch(`${netlifyFunctionsBaseUrl}/install-extension`, {
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
