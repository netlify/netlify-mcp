import type { ToolAnnotations } from '@modelcontextprotocol/server';
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

/**
 * Fill in every tool-behaviour hint explicitly.
 *
 * The MCP spec gives these defaults when a hint is omitted: `readOnlyHint`
 * false, `destructiveHint` TRUE, `idempotentHint` false, `openWorldHint` TRUE.
 * Tools here only declared `readOnlyHint`, so every read-only tool was being
 * published as implicitly destructive — and clients that surface these hints
 * (and reviewers that check them) saw nothing but the one key.
 *
 * `openWorldHint` is true. Two published definitions disagree here and it is
 * worth knowing which one this follows:
 *
 *   MCP schema — is the reachable set of entities bounded? "the world of a web
 *     search tool is open, whereas that of a memory tool is not." By that test
 *     these tools are CLOSED: they touch only the caller's own Netlify account.
 *   OpenAI apps rubric — true "when the tool accesses the public internet or
 *     open-ended external entities, including through read-only actions such as
 *     web search." By that test they are OPEN: every one calls api.netlify.com.
 *
 * We follow OpenAI's, because the apps directory is what reviews these values,
 * and it is also the spec default — so this is the conservative reading of an
 * ambiguous hint rather than a claim that the domain is unbounded.
 */
export const completeToolAnnotations = (annotations: ToolAnnotations): ToolAnnotations => {
  const readOnly = annotations.readOnlyHint === true;
  return {
    ...annotations,
    readOnlyHint: readOnly,
    // A read-only tool cannot destroy anything. For a writer the conservative
    // answer is the spec's own default, true, unless the tool says otherwise —
    // several of these bundle DELETEs (env vars, form submissions).
    destructiveHint: readOnly ? false : (annotations.destructiveHint ?? true),
    // Reads are repeatable; writes are not assumed to be.
    idempotentHint: readOnly ? true : (annotations.idempotentHint ?? false),
    openWorldHint: annotations.openWorldHint ?? true,
  };
};

/**
 * The annotations for a grouped selector tool, derived from the operations it
 * can actually run.
 *
 * Derived rather than hand-written so the published hints cannot drift from the
 * tools behind them: adding one destructive operation to a domain correctly
 * makes the whole selector destructive, with no second place to remember to
 * update.
 */
export const aggregateToolAnnotations = (tools: DomainTool<any>[]): ToolAnnotations => {
  const members = tools.map(tool => completeToolAnnotations(tool.toolAnnotations));
  return {
    // Read-only only if NOTHING it can run writes.
    readOnlyHint: members.every(a => a.readOnlyHint === true),
    // Destructive if ANY operation is.
    destructiveHint: members.some(a => a.destructiveHint === true),
    idempotentHint: members.every(a => a.idempotentHint === true),
    // Open-world if ANY operation reaches an unbounded set of entities.
    openWorldHint: members.some(a => a.openWorldHint === true),
  };
};
