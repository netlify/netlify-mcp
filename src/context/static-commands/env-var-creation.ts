import type { StaticCommand } from "./types.js";
import { command_env_vars } from "../ctx.js";

export const envVarCreation: StaticCommand = {
    operationId: 'environment-var-creation',
    commandText: command_env_vars
}
