import { getExtensions } from "../../../utils/api-networking.js";
import { appendErrorToLog, appendToLog } from "../../../utils/logging.js";
import type { StaticCommand } from "../types.js";

export const listExtensions: StaticCommand = {
    operationId: 'list-extensions',
    commandText: `
    Returns a list of public Netlify extensions. Always run this tool to check if user's request can be accomplished by one of the extensions.
    Use this list to decide if there is  a Netlify extension that can be used to accomplish the user's request.
    Then pass the extension's slug to the "get_extension_details" tool to get more details, and then use the "install_extension" tool to install it.
    `,
    runOperation: async () => {
      try {
        appendToLog('client called tool list_extensions');
        const extensionsData = await getExtensions();

        appendToLog(['got extensions', JSON.stringify(extensionsData)]);

        return JSON.stringify(extensionsData.map(extension => `name: ${extension.name}\nslug: ${extension.slug}\ndescription: ${extension.description}\ncategory: ${extension.category}\nauthor: ${extension.author}`));
      } catch (error: any) {
        appendErrorToLog(error);
        throw new Error(error)
      }
    },
    runRequiresParams: false
}
