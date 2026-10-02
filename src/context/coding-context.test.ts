import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  getCodingContextTopics,
  getNetlifyCodingContext,
  getSkillManifest,
  resetCodingContextCachesForTests,
  SKILLS_HOST,
} from './coding-context.ts';

const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

const VERSION = '9.9.9';
const FILES: Record<string, string> = {
  'netlify-functions/SKILL.md': '---\nname: netlify-functions\n---\n# Functions\r\n  trailing  \n',
  'netlify-database/SKILL.md': '---\nname: netlify-database\n---\n# Database\n',
  'netlify-database/references/migrations.md': '# Migrations\n',
  'netlify-database/references/local-dev.md': '# Local dev\n',
  'netlify-old/SKILL.md': '# Old\n',
};

const entry = (name: string, status: 'active' | 'deprecated', paths: string[]) => ({
  name,
  status,
  prior_names: [],
  description: `${name} description`,
  files: Object.fromEntries(paths.map((p) => [p, sha(FILES[`${name}/${p}`])])),
});

const manifest = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 1,
  version: VERSION,
  skills: [
    entry('netlify-functions', 'active', ['SKILL.md']),
    entry('netlify-database', 'active', ['SKILL.md', 'references/migrations.md', 'references/local-dev.md']),
    entry('netlify-old', 'deprecated', ['SKILL.md']),
  ],
  ...overrides,
});

const originalFetch = globalThis.fetch;
let requested: string[] = [];
let manifestBody: unknown;
let fileOverrides: Record<string, string>;

beforeEach(() => {
  resetCodingContextCachesForTests();
  requested = [];
  manifestBody = manifest();
  fileOverrides = {};
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url === `${SKILLS_HOST}/manifest.json`) {
      return new Response(JSON.stringify(manifestBody), { status: 200 });
    }
    const prefix = `${SKILLS_HOST}/v/${VERSION}/skills/`;
    if (url.startsWith(prefix)) {
      const key = url.slice(prefix.length);
      const body = fileOverrides[key] ?? FILES[key];
      if (body !== undefined) return new Response(body, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('topics are active skills plus legacy names whose target is active', async () => {
  manifestBody = manifest({
    skills: [
      entry('netlify-functions', 'active', ['SKILL.md']),
      entry('netlify-database', 'deprecated', ['SKILL.md']),
      entry('netlify-old', 'deprecated', ['SKILL.md']),
    ],
  });
  const topics = await getCodingContextTopics();
  assert.deepEqual(topics, ['netlify-functions', 'serverless']);
});

test('topics are empty when the manifest is unavailable', async () => {
  manifestBody = { schema_version: 1 };
  assert.deepEqual(await getCodingContextTopics(), []);
});

test('legacy name and full skill name resolve to the same skill', async () => {
  const legacy = await getNetlifyCodingContext('serverless');
  const full = await getNetlifyCodingContext('netlify-functions');
  assert.deepEqual(legacy, full);
  assert.deepEqual(full, { ok: true, text: FILES['netlify-functions/SKILL.md'] });
});

test('deprecated skills and unknown topics are errors', async () => {
  for (const topic of ['netlify-old', 'nope']) {
    const result = await getNetlifyCodingContext(topic);
    assert.equal(result.ok, false);
  }
});

test('a multi-file skill appends a note listing every reference path', async () => {
  const result = await getNetlifyCodingContext('db');
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  const skillMd = FILES['netlify-database/SKILL.md'];
  assert.ok(result.text.startsWith(`${skillMd}\n\n---\n`));
  const note = result.text.slice(skillMd.length);
  assert.ok(note.includes('- references/migrations.md\n- references/local-dev.md'));
  assert.ok(!note.includes('SKILL.md'));
});

test('a single-file skill has no note', async () => {
  const result = await getNetlifyCodingContext('netlify-functions');
  assert.deepEqual(result, { ok: true, text: FILES['netlify-functions/SKILL.md'] });
});

test('reference is returned verbatim with or without the references/ prefix', async () => {
  for (const reference of ['references/migrations.md', 'migrations.md']) {
    const result = await getNetlifyCodingContext('netlify-database', reference);
    assert.deepEqual(result, { ok: true, text: FILES['netlify-database/references/migrations.md'] });
  }
});

test('an unknown reference lists the valid ones and fetches nothing', async () => {
  for (const reference of ['foo.md', 'SKILL.md', '../netlify-functions/SKILL.md']) {
    requested = [];
    const result = await getNetlifyCodingContext('netlify-database', reference);
    assert.ok(!result.ok);
    assert.ok(result.error.includes(`Unknown reference "${reference}"`));
    assert.ok(result.error.includes('references/migrations.md, references/local-dev.md'));
    assert.deepEqual(requested.filter((u) => u.includes('/skills/')), []);
  }
});

test('a file whose bytes do not match the manifest hash is an error', async () => {
  fileOverrides['netlify-functions/SKILL.md'] = 'tampered';
  const result = await getNetlifyCodingContext('netlify-functions');
  assert.ok(!result.ok);
  assert.ok(result.error.includes('Hash mismatch'));
});

test('a file that failed verification is not served from cache later', async () => {
  fileOverrides['netlify-functions/SKILL.md'] = 'tampered';
  await getNetlifyCodingContext('netlify-functions');
  delete fileOverrides['netlify-functions/SKILL.md'];
  const result = await getNetlifyCodingContext('netlify-functions');
  assert.deepEqual(result, { ok: true, text: FILES['netlify-functions/SKILL.md'] });
});

test('manifest comes from /manifest.json, files from the versioned path, never docs.netlify.com', async () => {
  await getNetlifyCodingContext('netlify-database');
  await getNetlifyCodingContext('netlify-database', 'migrations.md');
  assert.deepEqual(requested, [
    `${SKILLS_HOST}/manifest.json`,
    `${SKILLS_HOST}/v/${VERSION}/skills/netlify-database/SKILL.md`,
    `${SKILLS_HOST}/v/${VERSION}/skills/netlify-database/references/migrations.md`,
  ]);
  assert.ok(requested.every((u) => !u.includes('docs.netlify.com')));
});

test('manifest and files are cached across calls', async () => {
  await getNetlifyCodingContext('netlify-functions');
  await getNetlifyCodingContext('serverless');
  await getCodingContextTopics();
  assert.equal(requested.filter((u) => u.endsWith('/manifest.json')).length, 1);
  assert.equal(requested.filter((u) => u.includes('/skills/')).length, 1);
});

test('a manifest with the wrong schema_version or no skills array is unavailable', async () => {
  manifestBody = manifest({ schema_version: 2 });
  assert.equal(await getSkillManifest(), undefined);
  manifestBody = { schema_version: 1, version: VERSION };
  assert.equal(await getSkillManifest(), undefined);
  const result = await getNetlifyCodingContext('netlify-functions');
  assert.ok(!result.ok);
});

test('a failed manifest request is not cached', async () => {
  globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
  assert.equal(await getSkillManifest(), undefined);
  globalThis.fetch = (async () => new Response(JSON.stringify(manifest()), { status: 200 })) as typeof fetch;
  assert.ok(await getSkillManifest());
});
