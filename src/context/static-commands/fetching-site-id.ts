import type { StaticCommand } from "./types.js"
import { siteIdContext } from "../ctx.js"
import { getSiteId } from "../../utils/api-networking.js";
import { runCommand } from "../../utils/cmd.js";

export const fetchingSiteId: StaticCommand = {
  operationId: 'get-site-id',
  // having the agent look it up has been more reliable than
  // having it give a directory for us to work with
  commandText: siteIdContext
//   commandText: `
// YOU MUST CALL, the call-netlify-apis with get-site-id operation and these params

// {
//   "root_directory": "<absolute path to directory>"
// }
//   `,
  // runOperation: async (params) => {
  //   const { root_directory } = params as { root_directory: string };
  //   let siteId = '';

  //   try {
  //     siteId = await getSiteId({ projectDir: root_directory || process.cwd() });

  //     if(!siteId && root_directory) {
  //       const result = await runCommand('netlify status', { cwd: root_directory });
  //       const fullResp = result.stdout;
  //       if(fullResp){
  //         // regex for "Site Id:   5f9562c1-be9c-4898-bc6a-5b40de4e1450"
  //         const siteIdRegex = /Site Id:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/;
  //         const match = fullResp.match(siteIdRegex);
  //         if (match && match[1]) {
  //           siteId = match[1];
  //         }
  //       }
  //     }
  //   } catch { }

  //   if(!siteId && root_directory) {
  //     throw new Error('The provided project does not seem to be linked to Netlify. Run `netlify link` on that directory to set up the link and retry this command');
  //   }

  //   return siteId;
  // },
  // runRequiresParams: true
}
