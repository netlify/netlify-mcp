
import { getProjectDomainTool } from './get-project.js';
import { getProjectsDomainTool } from './get-projects.js';
import { updateVisitorAccessControlsDomainTool } from './update-visitor-access-controls.js';

export const projectDomainTools = [getProjectDomainTool, getProjectsDomainTool, updateVisitorAccessControlsDomainTool]
