import type { DomainTool } from './types.js';
import { z } from 'zod';

export const createToolResponseWithFollowup = (respPayload: any, followup: string)=>{
  return {
    followupForAgentsOnly: followup,
    rawToolResponse: respPayload
  };
}

export const categorizeToolsByReadWrite = (domainTools: DomainTool<any>[]) => {
  const readOnlyTools = domainTools.filter(tool => tool.toolAnnotations.readOnlyHint === true);
  const writeTools = domainTools.filter(tool => tool.toolAnnotations.readOnlyHint === false || tool.toolAnnotations.readOnlyHint === undefined);
  
  return {
    readOnlyTools,
    writeTools
  };
};
