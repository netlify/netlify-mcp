import { getRunDomainTool } from './get-run.js';
import { listRunsDomainTool } from './list-runs.js';
import { startRunDomainTool } from './start-run.js';

export const agentRunnerDomainTools = [
  getRunDomainTool,
  listRunsDomainTool,
  startRunDomainTool,
];
