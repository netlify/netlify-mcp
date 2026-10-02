import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aggregateToolAnnotations, completeToolAnnotations } from './tool-utils.ts';
import { userDomainTools } from './user-tools/index.ts';
import { deployDomainTools } from './deploy-tools/index.ts';
import { teamDomainTools } from './team-tools/index.ts';
import { projectDomainTools } from './project-tools/index.ts';
import { extensionDomainTools } from './extension-tools/index.ts';

// The three the apps directory requires as direct boolean keys. idempotentHint
// is set too, but only these three are externally mandated.
const REQUIRED = ['readOnlyHint', 'destructiveHint', 'openWorldHint'] as const;

const ALL_DOMAIN_TOOLS = [
  ...userDomainTools, ...deployDomainTools, ...teamDomainTools,
  ...projectDomainTools, ...extensionDomainTools,
];

test('every domain tool completes to explicit booleans', () => {
  // The gap this closes: tools declared only readOnlyHint, and the MCP spec
  // defaults omitted hints to destructiveHint TRUE and openWorldHint TRUE — so
  // read-only tools were published as implicitly destructive, and a reviewer
  // checking for direct boolean keys found one.
  for (const tool of ALL_DOMAIN_TOOLS) {
    const a = completeToolAnnotations(tool.toolAnnotations);
    for (const key of REQUIRED) {
      assert.equal(
        typeof a[key], 'boolean',
        `${tool.domain}/${tool.operation} is missing a boolean ${key}`,
      );
    }
  }
});

test('a read-only tool is never published as destructive', () => {
  const a = completeToolAnnotations({ readOnlyHint: true });
  assert.deepEqual(a, {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  });
});

test('a writer defaults to destructive unless it says otherwise', () => {
  // Conservative by default — several writers bundle DELETEs (env vars, form
  // submissions), so silence must not read as "safe".
  assert.equal(completeToolAnnotations({ readOnlyHint: false }).destructiveHint, true);
  // ...but a genuinely additive writer can opt out.
  assert.equal(
    completeToolAnnotations({ readOnlyHint: false, destructiveHint: false }).destructiveHint,
    false,
  );
});

test('completeToolAnnotations never overrides an explicit value', () => {
  const a = completeToolAnnotations({
    readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  });
  assert.deepEqual(a, {
    readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  });
});

test('a grouped selector takes the worst case of its members', () => {
  const mk = (readOnlyHint: boolean, destructiveHint?: boolean) =>
    ({ domain: 'project', operation: 'x', toolAnnotations: { readOnlyHint, destructiveHint } }) as any;

  // One writer among readers makes the whole selector a writer.
  const mixed = aggregateToolAnnotations([mk(true), mk(false)]);
  assert.equal(mixed.readOnlyHint, false);
  assert.equal(mixed.destructiveHint, true);

  // All readers stays read-only and non-destructive.
  const reads = aggregateToolAnnotations([mk(true), mk(true)]);
  assert.equal(reads.readOnlyHint, true);
  assert.equal(reads.destructiveHint, false);
  assert.equal(reads.idempotentHint, true);

  // Writers that are all additive do not become destructive.
  const additive = aggregateToolAnnotations([mk(false, false), mk(false, false)]);
  assert.equal(additive.readOnlyHint, false);
  assert.equal(additive.destructiveHint, false);

  // ...but one destructive member is enough.
  const anyDestructive = aggregateToolAnnotations([mk(false, false), mk(false, true)]);
  assert.equal(anyDestructive.destructiveHint, true);
});

test('the real reader/updater groupings land on sensible hints', () => {
  const readers = ALL_DOMAIN_TOOLS.filter(t => t.toolAnnotations.readOnlyHint === true);
  const writers = ALL_DOMAIN_TOOLS.filter(t => t.toolAnnotations.readOnlyHint !== true);
  assert.ok(readers.length > 0 && writers.length > 0, 'expected both kinds to exist');

  const r = aggregateToolAnnotations(readers);
  assert.deepEqual(
    [r.readOnlyHint, r.destructiveHint, r.openWorldHint], [true, false, true],
  );

  const w = aggregateToolAnnotations(writers);
  assert.deepEqual(
    // Destructive because env-var and form-submission management issue DELETEs.
    [w.readOnlyHint, w.destructiveHint, w.openWorldHint], [false, true, true],
  );
});
