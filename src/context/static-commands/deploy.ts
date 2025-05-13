import { appendToLog } from "../../utils/logging.js";
import type { StaticCommand } from "./types.js";

export const envVarCreation: StaticCommand = {
    operationId: 'deploy-site',
    commandText: `

- provide the absolute file path to the directory containing the site that should be deployed

The payload should be a JSON object with the following properties:
{
  "deployDirectory": "<absolute path to directory>"
}
    `,
    runOperation: async (params) => {

      appendToLog(["Deploying site...", JSON.stringify(params)]);

      return '';
    },
    runRequiresParams: true
}
