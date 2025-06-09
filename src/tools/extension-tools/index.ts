
import { changeExtensionInstallationDomainTool } from './change-extension-installation.js';
import { getExtensionsDomainTool } from './get-extensions.js';
import { getFullExtensionDetailsDomainTool } from './get-full-extension-details.js';
import { initializeDatabaseDomainTool } from './initialize-database.js';

export const extensionDomainTools = [changeExtensionInstallationDomainTool, getExtensionsDomainTool, getFullExtensionDetailsDomainTool, initializeDatabaseDomainTool]
