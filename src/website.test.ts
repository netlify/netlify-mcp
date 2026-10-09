import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('the root website and native Netlify 404 fallback serve the same content', async () => {
  const homepage = await readFile(new URL('index.html', root), 'utf8');
  const fallback = await readFile(new URL('404.html', root), 'utf8');

  assert.equal(fallback, homepage);
  assert.match(homepage, /<!doctype html>/i);
  assert.match(homepage, /<html lang="en">/);
  assert.match(homepage, /<h1>Netlify MCP Server<\/h1>/);
  assert.match(homepage, /<code>\/mcp<\/code>/);
});

test('the website works at nested missing paths without relative assets or links', async () => {
  const fallback = await readFile(new URL('404.html', root), 'utf8');
  const references = [...fallback.matchAll(/(?:href|src)="([^"]+)"/g)];

  assert.ok(references.length > 0);
  for (const [, reference] of references) {
    assert.ok(reference.startsWith('/') || reference.startsWith('https://'), reference);
  }
});
