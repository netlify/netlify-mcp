import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

import { getPackageVersion } from './version.ts';

test('getPackageVersion reports the real package version, not the 0.0.0 fallback', () => {
  // Regression: the resolver only tried '../package.json', which is correct for
  // the published dist/ bundle but resolves to a nonexistent src/package.json
  // from source. Every deployed instance therefore advertised serverInfo
  // version "0.0.0" — visible to any MCP client that inspects it.
  const expected = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

  assert.equal(getPackageVersion(), expected);
  assert.notEqual(getPackageVersion(), '0.0.0');
  assert.match(getPackageVersion(), /^\d+\.\d+\.\d+/);
});

test('getPackageVersion is stable across calls', () => {
  // The result is memoized; a second call must not re-resolve to something else.
  assert.equal(getPackageVersion(), getPackageVersion());
});
