
import { getDeployByIdDomainTool } from './get-deploy.js';
import { getDeployBySiteIdDomainTool } from './get-deploy-for-site.js';
import { deploySiteDomainTool, deploySiteRemotelyDomainTool } from './deploy-site.js';

export const deployDomainTools = [getDeployByIdDomainTool, getDeployBySiteIdDomainTool, deploySiteDomainTool, deploySiteRemotelyDomainTool];
