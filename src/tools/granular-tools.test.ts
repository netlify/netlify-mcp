import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isOpenAIMCPClient } from '../utils/client-detection.ts';
import { completeToolAnnotations } from './tool-utils.ts';
import { userDomainTools } from './user-tools/index.ts';
import { deployDomainTools } from './deploy-tools/index.ts';
import { teamDomainTools } from './team-tools/index.ts';
import { projectDomainTools } from './project-tools/index.ts';
import { extensionDomainTools } from './extension-tools/index.ts';

const REMOTE_TOOLS = [
  ...userDomainTools, ...deployDomainTools, ...teamDomainTools,
  ...projectDomainTools, ...extensionDomainTools,
].filter(t => !t.omitFromRemoteMCP);

const ua = (value?: string) =>
  new Request('https://x/mcp', { headers: value === undefined ? {} : { 'user-agent': value } });

test('isOpenAIMCPClient matches the openai-mcp agent, normalized', () => {
  assert.equal(isOpenAIMCPClient(ua('openai-mcp/1.0.0')), true);
  assert.equal(isOpenAIMCPClient(ua('OpenAI-MCP/1.0.0')), true, 'case-insensitive');
  assert.equal(isOpenAIMCPClient(ua('  openai-mcp/1.0.0  ')), true, 'leading space tolerated');
  assert.equal(isOpenAIMCPClient(ua('openai-mcp')), true, 'bare agent, no version');
});

test('isOpenAIMCPClient does not match anything else', () => {
  // Prefix match, so an agent that merely mentions openai elsewhere is not a hit.
  for (const value of [
    'claude-code/1.2.3', 'node', '', 'some-proxy/1.0 openai-mcp/1.0',
    'notopenai-mcp/1.0', 'openai/1.0',
  ]) {
    assert.equal(isOpenAIMCPClient(ua(value)), false, `${value || '(empty)'} should not match`);
  }
  assert.equal(isOpenAIMCPClient(ua()), false, 'no user-agent header');
  assert.equal(isOpenAIMCPClient(undefined), false, 'no request at all');
});

test('every remotely-exposed operation has its own description', () => {
  // The granular surface has no domain-level description to lean on, and the
  // generated fallback only restates the tool name — which the app guidelines
  // reject as leaving behaviour "unclear or incomplete".
  for (const tool of REMOTE_TOOLS) {
    assert.ok(tool.description, `${tool.domain}/${tool.operation} has no description`);
    assert.ok(
      tool.description!.length > 60,
      `${tool.domain}/${tool.operation} description is too thin to explain behaviour`,
    );
    assert.equal(
      tool.description!.includes(`${tool.operation} operation for`), false,
      `${tool.domain}/${tool.operation} is still using the generated stub`,
    );
  }
});

test('every remotely-exposed operation declares all three required hints', () => {
  for (const tool of REMOTE_TOOLS) {
    const a = completeToolAnnotations(tool.toolAnnotations);
    for (const key of ['readOnlyHint', 'destructiveHint', 'openWorldHint'] as const) {
      assert.equal(typeof a[key], 'boolean', `${tool.operation} missing ${key}`);
    }
  }
});

test('destructive hints are set per operation, not per domain', () => {
  // The whole point of the granular surface: the project domain contains both
  // a delete (env vars) and a purely additive create, and they must no longer
  // share one worst-case annotation.
  const byOp = Object.fromEntries(
    REMOTE_TOOLS.map(t => [t.operation, completeToolAnnotations(t.toolAnnotations)]),
  );

  // Deletes and overwrites.
  for (const op of [
    'manage-env-vars', 'manage-form-submissions', 'update-project-name',
    'update-visitor-access-controls', 'change-extension-installation', 'deploy-site',
  ]) {
    assert.equal(byOp[op].destructiveHint, true, `${op} should be destructive`);
  }

  // Additive or inert writes no longer inherit the domain's worst case.
  for (const op of ['create-new-project', 'update-forms', 'initialize-database']) {
    assert.equal(byOp[op].readOnlyHint, false, `${op} is still a write`);
    assert.equal(byOp[op].destructiveHint, false, `${op} should NOT be destructive`);
  }

  // create-new-project is additive but not repeatable: each call makes another.
  assert.equal(byOp['create-new-project'].idempotentHint, false);
  assert.equal(byOp['deploy-site'].idempotentHint, false);
});
