import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildServerCard, SERVER_CARD_PATH, SERVER_CARD_SCHEMA } from './server-card.ts';
import handler, { config } from '../server-card.ts';

test('server card: required fields match the ext-server-card shape', () => {
  const card = buildServerCard('https://mcp.netlify.com');
  assert.equal(card.$schema, SERVER_CARD_SCHEMA);
  assert.match(card.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  assert.ok(card.description.length > 0 && card.description.length <= 100);
  assert.match(card.version, /^\d+\.\d+\.\d+/);
  assert.notEqual(card.version, '0.0.0');
});

test('server card: branding (title + icon) is present', () => {
  const card = buildServerCard('https://mcp.netlify.com');
  assert.ok(card.title);
  assert.ok(card.icons.length > 0);
  for (const icon of card.icons) {
    assert.ok(icon.src.startsWith('https://'), `icon must be https: ${icon.src}`);
  }
});

test('server card: remote URL is the MCP endpoint on the requesting origin', () => {
  for (const origin of ['https://mcp.netlify.com', 'https://netlify-mcp.netlify.app']) {
    const card = buildServerCard(origin);
    assert.deepEqual(card.remotes, [{ type: 'streamable-http', url: `${origin}/mcp` }]);
  }
});

test('server card handler: serves JSON with the card media type and CORS', async () => {
  const res = await handler(new Request('https://mcp.netlify.com/mcp/server-card'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/mcp-server-card+json');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const body = await res.json();
  assert.equal(body.remotes[0].url, 'https://mcp.netlify.com/mcp');
});

test('server card handler: rejects writes', async () => {
  const res = await handler(new Request('https://mcp.netlify.com/mcp/server-card', { method: 'POST' }));
  assert.equal(res.status, 405);
});

test('server card function: routed at the recommended <mcp-url>/server-card path', () => {
  // config.path must be literals (Netlify parses it statically), so guard
  // against it drifting from the path the module advertises.
  assert.ok(config.path?.includes(SERVER_CARD_PATH));
});
