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
  assert.match(homepage, /<h1>.*Fleet.*<\/h1>/i);
  assert.match(homepage, /<code>\/mcp<\/code>/);
});

test('the PetSmart banner uses the approved text and official destination above the header', async () => {
  const homepage = await readFile(new URL('index.html', root), 'utf8');

  assert.match(homepage, /<body>\s*<a class="store-banner" href="https:\/\/www\.petsmart\.com\/">Visit PetSmart for pet supplies<\/a>\s*<header>/);
  assert.match(homepage, /\.store-banner:focus-visible\s*\{/);
  assert.doesNotMatch(homepage, /petm\.app\.link|5,000 pts/);
});

test('the website works at nested missing paths without relative assets or links', async () => {
  const fallback = await readFile(new URL('404.html', root), 'utf8');
  const references = [...fallback.matchAll(/(?:href|src)="([^"]+)"/g)];

  assert.ok(references.length > 0);
  for (const [, reference] of references) {
    assert.ok(reference.startsWith('/') || reference.startsWith('https://') || reference.startsWith('#'), reference);
  }
});

test('official stores are external links and disconnected checkout is explicit', async () => {
  const homepage = await readFile(new URL('index.html', root), 'utf8');
  for (const url of ['https://www.tesla.com/', 'https://shop.tesla.com/', 'https://www.apple.com/store']) {
    assert.ok(homepage.includes(`href="${url}"`));
  }
  assert.match(homepage, /not affiliated with Tesla or Apple/);
  assert.match(homepage, /<button class="checkout-btn" disabled aria-describedby="checkout-status">/);
  assert.match(homepage, /Shopify and Apple Pay are not connected/);
  assert.doesNotMatch(homepage, /Ready for live Shopify checkout|function handleCheckout/);
});

test('the public website rewrite is last and does not override existing static assets', async () => {
  const config = await readFile(new URL('netlify.toml', root), 'utf8');
  const redirects = config.split('[[redirects]]').slice(1);
  const fallback = redirects.at(-1)!;

  assert.match(fallback, /^\s*from = "\/\*"\s*$/m);
  assert.match(fallback, /^\s*to = "\/index\.html"\s*$/m);
  assert.match(fallback, /^\s*status = 200\s*$/m);
  assert.doesNotMatch(config, /^\s*force = true\s*$/m);

  const apiRoutes = new Map([
    ['/mcp', '.netlify/functions/mcp'],
    ['/mcp/*', '.netlify/functions/mcp/:splat'],
    ['/oauth-server/*', '.netlify/functions/oauth-server/:splat'],
    ['/token', '.netlify/functions/oauth-server/token'],
    ['/authorize', '.netlify/functions/oauth-server/auth'],
    ['/register', '.netlify/functions/oauth-server/register'],
    ['/.well-known/oauth-protected-resource', '.netlify/functions/oauth-server/.well-known/oauth-protected-resource'],
    ['/.well-known/oauth-protected-resource/*', '.netlify/functions/oauth-server/.well-known/oauth-protected-resource'],
    ['/.well-known/oauth-authorization-server', '.netlify/functions/oauth-server/.well-known/oauth-authorization-server'],
    ['/.well-known/openid-configuration', '.netlify/functions/oauth-server/openid-configuration'],
    ['/events/relay/*', '.netlify/functions/events-relay/:splat'],
  ]);
  for (const [from, to] of apiRoutes) {
    const rule = redirects.slice(0, -1).find(block => block.includes(`from = "${from}"`));
    assert.ok(rule, `${from} must route before the website fallback`);
    assert.ok(rule.includes(`to = "${to}"`), `${from} must route to its function`);
    assert.match(rule, /^\s*status = 200\s*$/m);
  }

  assert.match(config, /\[\[edge_functions\]\]\s+function = "proxy"\s+path = "\/proxy\/:token\/\*"/);
});
