import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, deployIdFromJob, projectMarker, importSiteName, fallbackImportSiteName, matchTeam } from './job-utils.ts';

test('slugify returns undefined for missing or empty titles', () => {
  assert.equal(slugify(undefined), undefined);
  assert.equal(slugify(''), undefined);
  assert.equal(slugify('!!!'), undefined);
});

test('slugify lowercases, hyphenates, and trims to a valid site name', () => {
  assert.equal(slugify('My Cool Design'), 'my-cool-design');
  assert.equal(slugify('  Spaces & Symbols!! '), 'spaces-symbols');
  assert.equal(slugify('Trailing---'), 'trailing');
});

test('slugify caps length at 40 chars with no trailing hyphen', () => {
  const out = slugify('a'.repeat(60))!;
  assert.ok(out.length <= 40);
  assert.doesNotMatch(out, /-$/);
});

test('projectMarker is deterministic, url-safe, and does not expose the project id', () => {
  const marker = projectMarker('p1782841610658559');
  assert.equal(marker, projectMarker('p1782841610658559'));
  assert.match(marker, /^cd-[0-9a-f]{10}$/);
  assert.ok(!marker.includes('1782841610658559'));
  assert.notEqual(marker, projectMarker('p999'));
});

test('importSiteName combines title slug with the project marker', () => {
  assert.equal(importSiteName('My Cool Design'), 'my-cool-design');
  assert.equal(importSiteName('My Cool Design', 'p123'), `my-cool-design-${projectMarker('p123')}`);
  assert.equal(importSiteName(undefined, 'p123'), projectMarker('p123'));
  assert.equal(importSiteName(undefined, undefined), undefined);
});

test('importSiteName stays within the 63-char subdomain limit', () => {
  const name = importSiteName('x'.repeat(100), 'p123')!;
  assert.ok(name.length <= 63, `name is ${name.length} chars`);
});

test('fallbackImportSiteName keeps the marker so re-send lookups still match', () => {
  const name = fallbackImportSiteName('p123', 'a1b2c3');
  assert.equal(name, `${projectMarker('p123')}-a1b2c3`);
  assert.ok(name.includes(projectMarker('p123')));
  assert.notEqual(name, fallbackImportSiteName('p123', 'z9y8x7'));
});

test('matchTeam resolves by slug or name case-insensitively, else returns a fallback note', () => {
  const teams = [{ slug: 'acme-team', name: 'Acme Inc' }, { slug: 'personal', name: 'Justin H' }];
  assert.deepEqual(matchTeam(teams, 'acme-team'), { slug: 'acme-team' });
  assert.deepEqual(matchTeam(teams, 'Acme Inc'), { slug: 'acme-team' }); // by name
  assert.deepEqual(matchTeam(teams, 'ACME-TEAM'), { slug: 'acme-team' }); // case-insensitive
  // unknown team -> no slug (default team) + an explanatory note
  const miss = matchTeam(teams, 'acmee');
  assert.equal(miss.slug, undefined);
  assert.match(miss.note ?? '', /was not found/);
  // empty team list -> also a note, never a throw
  assert.equal(matchTeam([], 'anything').slug, undefined);
});

test('deployIdFromJob returns a plain id and rejects ids that could traverse the deploy path', () => {
  assert.equal(deployIdFromJob('deploy-456'), 'deploy-456');
  // job_id is interpolated into GET /api/v1/deploys/<id>; a slash or dot segment
  // would resolve to a different authenticated endpoint.
  assert.throws(() => deployIdFromJob('../../user'), /invalid job_id/);
  assert.throws(() => deployIdFromJob('a/b'), /invalid job_id/);
  assert.throws(() => deployIdFromJob(''), /invalid job_id/);
});

