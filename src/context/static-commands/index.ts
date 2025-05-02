import { StaticCommand } from "./types.js";
import { fetchingSiteId } from "./fetching-site-id.js";
import { envVarCreation } from "./env-var-creation.js";

export const staticCommands: StaticCommand[] = [
  fetchingSiteId,
  envVarCreation
]
