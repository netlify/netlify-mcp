import type { StaticCommand } from "./types.js";
import { command_env_vars } from "../ctx.js";

export const envVarCreation: StaticCommand = {
    name: 'environment-var-creation',
    commandText: command_env_vars
}
