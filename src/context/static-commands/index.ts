import { StaticCommand } from "./types.js";
import { fetchingSiteId } from "./fetching-site-id.js";
import { envVarCreation } from "./env-var-creation.js";
import { deploySite } from "./deploy-site.js";

// static commands are those that we build and define on the MCP
// server itself. It's not imported from docs or openapi specs
// and such.
export const staticCommands: StaticCommand[] = [
  fetchingSiteId,
  envVarCreation,
  deploySite,

  // TODO: try operation variants
  // define a new id, but the text would be the same from get-operation
  // then after the run operation we would invoke the override with the data
  // or perhaps just allowing a reducer function to specify which fields they need

  // Might need to update the run command tool to allow understanding of paging
  // have it call it with new pages until there are no more
  // {
  //   operationId: 'countSites',
  //   commandText: 'Get the list of sites and their ids',
  //   runOperation: async () => {

  //     const response = await fetch('https://api.netlify.com/api/v1/sites', {
  //       headers: {
  //         'Authorization': `Bearer ${process.env.NETLIFY_PERSONAL_ACCESS_TOKEN}`
  //       }
  //     });

  //     // todo: handling paging

  //     const data = await response.json();

  //     let updatedData = data;

  //     if(data){
  //       updatedData = data.map((site: any) => ({
  //         id: site.id,
  //         name: site.name,
  //         account_id: site.account_id,
  //         account_slug: site.account_slug
  //       }));
  //     }

  //     return JSON.stringify(updatedData);
  //   },
  //   runRequiresParams: false
  // }
]

