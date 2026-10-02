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
 * `openWorldHint` is false. The hint is not "does this make a network call" —
 * the spec's test is whether the set of entities the tool can reach is bounded:
 * "the world of a web search tool is open, whereas that of a memory tool is
 * not." These tools act only on the caller's own Netlify account — their sites,
 * deploys, teams, env vars — which is an enumerable, closed domain, much closer
 * to the memory example than the search one. It happens to differ from the
 * spec's default of true, which is exactly why it has to be stated.
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
    openWorldHint: annotations.openWorldHint ?? false,
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
