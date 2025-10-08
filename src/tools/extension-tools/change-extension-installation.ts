
import { z } from 'zod'
import { getExtension, getSite, changeExtensionInstallation } from './extension-utils.js';
import { appendErrorToLog, appendToLog } from '../../utils/logging.js';
import type { DomainTool } from '../types.js';

const changeExtensionInstallationParamsSchema = z.object({
  extensionSlug: z.string(),
  shouldBeInstalled: z.boolean(),
  teamId: z.string().describe('Team id of the current project team. If unsure, ask what Netlify team'),
  siteId: z.string().optional().describe('Site id of the current project site. If unsure, ask what Netlify site'),
});

export const changeExtensionInstallationDomainTool: DomainTool<typeof changeExtensionInstallationParamsSchema> = {
  domain: 'extension',
  operation: 'change-extension-installation',
  inputSchema: changeExtensionInstallationParamsSchema,
  toolAnnotations: {
    readOnlyHint: false,
  },
  cb: async ({ extensionSlug, shouldBeInstalled, teamId, siteId }, {request}) => {

    try {

      await changeExtensionInstallation({
        shouldBeInstalled,
        accountId: teamId,
        extensionSlug,
        request,
      });

      appendToLog(`Extension "${extensionSlug}" successfully ${shouldBeInstalled ? 'installed' : 'uninstalled'} on account "${teamId}"`);

      // Check if extension has site-level configuration
      const extensionData = await getExtension({
        accountId: teamId,
        extensionSlug,
        request
      });

      if (extensionData?.uiSurfaces?.includes('extension-team-configuration')) {
        if (shouldBeInstalled) {
          return `Extension has been installed successfully. Configure it here: https://app.netlify.com/team/${teamId}/extension/${extensionSlug}`
        }
      }else if (siteId && extensionData.uiSurfaces?.includes('extension-top-level-site-configuration')) {
        const site = await getSite({ siteId, incomingRequest: request });

        if(shouldBeInstalled){
          return `Extension has been installed successfully. Configure it here: https://app.netlify.com/sites/${site.name}/extensions/${extensionSlug}`
        }
      }

    } catch (error: any) {
      const errorMessage = error.message || 'Failed to install extension';
      appendErrorToLog(errorMessage);
      return `Failed to ${shouldBeInstalled ? 'install' : 'uninstall'} the extension. Ensure the extension slug is correct but getting the list of extensions. Error: ${errorMessage}`
    }

    return `Extension ${shouldBeInstalled ? 'installed' : 'uninstalled'} successfully.`;
  }
};
