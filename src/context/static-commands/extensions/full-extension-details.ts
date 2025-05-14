import { getExtension, getSite, getSiteId } from "../../../utils/api-networking.js";
import { appendErrorToLog, appendToLog } from "../../../utils/logging.js";
import type { StaticCommand } from "../types.js";

export const fullExtensionDetails: StaticCommand = {
  operationId: 'full-extension-details',
  commandText: `
Returns detailed information about a Netlify extensions.
Use "list-extensions" tool to get list of Netlify extensions with their extension slugs.

When the agent has a siteId or deploy_directory, it MUST use the call-netlify-command tool for full-extension-details with the
following payload.

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

    const { extensionSlug, siteId: passedSiteId, deploy_directory } = params as { extensionSlug: string; siteId?: string; deploy_directory?: string };

    if(!passedSiteId && !deploy_directory){
      throw new Error('You must provide either the siteId or deploy_directory.');
    }

    try {
      if (deploy_directory) {
        siteId = await getSiteId({ projectDir: deploy_directory });
      }

      if (siteId) {
        const site = await getSite({ siteId });
        accountId = site.account_id;
      }
    } catch (error: any) {
      appendErrorToLog(`Failed to get site id: ${error.message}`);
      throw new Error(`Failed to get site id: ${error}`);
    }


    try {
      appendToLog(
        `client called tool get_extension_details({extensionSlug: "${extensionSlug}", siteId: "${siteId}", deploy_directory: "${deploy_directory}"})`
      );
      const extensionData = await getExtension({
        accountId,
        extensionSlug
      });
      appendToLog(`got extension details: ${JSON.stringify(extensionData)}`);
      return JSON.stringify(extensionData);
    } catch (error: any) {
      appendErrorToLog(`Failed to get extension details: ${error.message}`);
      throw new Error(`Failed to get extension details: ${error.message}`);
    }
  },
  runRequiresParams: true
}
