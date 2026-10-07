
import { getTeamsDomainTool } from './get-teams.js';
import { getTeamDomainTool } from './get-team.js';
import { getTeamEnvVarsDomainTool } from './get-team-env-vars.js';

export const teamDomainTools = [getTeamsDomainTool, getTeamDomainTool, getTeamEnvVarsDomainTool]
