
import { getProjectDomainTool } from './get-project.js';
import { getProjectsDomainTool } from './get-projects.js';
import { updateVisitorAccessControlsDomainTool } from './update-visitor-access-controls.js';
import { updateFormsDomainTool } from './update-project-forms.js';
import { getFormsForProjectDomainTool } from './get-forms-for-project.js';
import { manageFormSubmissionsDomainTool } from './manage-form-submissions.js';
import { updateProjectNameDomainTool } from './update-project-name.js';
import { manageEnvVarsDomainTool } from './manage-project-env-vars.js';
import { createNewProjectDomainTool } from './create-new-project.js';

export const projectDomainTools = [
  getProjectDomainTool,
  getProjectsDomainTool,
  updateVisitorAccessControlsDomainTool,
  updateFormsDomainTool,
  getFormsForProjectDomainTool,
  manageFormSubmissionsDomainTool,
  updateProjectNameDomainTool,
  manageEnvVarsDomainTool,
  createNewProjectDomainTool,
]
