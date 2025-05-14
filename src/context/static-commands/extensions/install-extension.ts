import { getExtension, getSite, getSiteId, installExtension } from "../../../utils/api-networking.js";
import { appendErrorToLog, appendToLog } from "../../../utils/logging.js";
import type { StaticCommand } from "../types.js";

export const installExtensionCmd: StaticCommand = {
  operationId: 'install-extension',
  commandText: `
Installs a Netlify extension. DO NOT USE THE CLI

use the netlify MCP tool "call-netlify-apis" with this same operationId and the following payload to install.

The payload should be a JSON object with the following properties:
{
  extensionSlug: string;

  siteId?: <site id of the current project site>;
  deploy_directory?: "<absolute path to directory>",
}

You must provide either the siteId or deploy_directory. Prefer the siteId if you already know it
  `,
  runOperation: async (params) => {

    let accountId = '';
    let siteId = '';
    let siteName = '';

    const { extensionSlug, siteId: passedSiteId, deploy_directory } = params as { extensionSlug: string; siteId?: string; deploy_directory?: string };

    if(!passedSiteId && !deploy_directory){
      throw new Error('You must provide either the siteId or deploy_directory.');
    }

    try {

      if (passedSiteId) {
        siteId = passedSiteId;
      }

      if (deploy_directory) {
        siteId = await getSiteId({ projectDir: deploy_directory });
      }

      if (siteId) {
        const site = await getSite({ siteId });
        accountId = site.account_id;
        siteName = site.name;
      }
    } catch (error: any) {
      appendErrorToLog(`Failed to get site id: ${error.message}`);
      throw new Error(`Failed to get site id: ${error}`);
    }


    try {
      appendToLog(
        `client called tool install_extension({siteId: "${siteId}", extensionSlug: "${extensionSlug}"})`
      );
      await installExtension({
        accountId,
        extensionSlug
      });
      appendToLog(`extension "${extensionSlug}" successfully installed on accountId "${accountId}"`);

      const extensionData = await getExtension({
        accountId,
        extensionSlug
      });

      if (extensionData.uiSurfaces?.includes('extension-top-level-site-configuration')) {
        return JSON.stringify({
          siteLevelConfigurationUrl: `https://app.netlify.com/sites/${siteName}/extensions/${extensionSlug}`
        });
      }

      return 'Extension successfully installed';
    } catch (error: any) {
      appendErrorToLog(error.message);
      throw new Error(error.message);
    }
  },
  runRequiresParams: true
}
