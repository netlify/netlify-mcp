import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { BlobsOAuthStore, OAuthStorageError } from './oauth-store.ts';

// The store is exercised through the real @netlify/blobs client; only the HTTP
// layer underneath it is answered here, so these tests see which endpoint each
// read actually goes to.

const EDGE = 'https://edge.blobs.example';
const UNCACHED = 'https://uncached.blobs.example';

const origFetch = globalThis.fetch;
const origError = console.error;
const origWarn = console.warn;
let requests: string[] = [];

function setContext(context: Record<string, string>) {
  (globalThis as { netlifyBlobsContext?: string }).netlifyBlobsContext = Buffer.from(JSON.stringify(context)).toString('base64');
}

before(() => {
  console.error = () => {};
  console.warn = () => {};
});
after(() => {
  console.error = origError;
  console.warn = origWarn;
});
afterEach(() => {
  globalThis.fetch = origFetch;
  delete (globalThis as { netlifyBlobsContext?: string }).netlifyBlobsContext;
  requests = [];
});

function answer(status: number, body = '', headers: Record<string, string> = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    return new Response(status === 404 ? null : body, { status, headers });
  }) as typeof fetch;
}

test('grant store reads go to the uncached endpoint', async () => {
  setContext({ siteID: 'site', token: 'blobs-token', edgeURL: EDGE, uncachedEdgeURL: UNCACHED });
  answer(200, JSON.stringify({ id: 'g1', revoked: { at: 1, reason: 'test' } }), { etag: '"e1"' });

  const found = await new BlobsOAuthStore().getGrant('g1');

  assert.equal(found?.record.revoked?.reason, 'test');
  assert.equal(found?.etag, '"e1"');
  assert.equal(requests.length, 1);
  assert.ok(requests[0].startsWith(UNCACHED), `read went to ${new URL(requests[0]).origin}`);
});

test('without an uncached endpoint every read is refused, never served from the cache', async () => {
  // This is the context the Lambda-compatibility handler received. A cached
  // read could return a grant from before its revocation, so the store must
  // refuse rather than downgrade.
  setContext({ siteID: 'site', token: 'blobs-token', edgeURL: EDGE });
  answer(200, JSON.stringify({ id: 'g1', revoked: null }), { etag: '"e1"' });

  const store = new BlobsOAuthStore();
  await assert.rejects(store.getGrant('g1'), OAuthStorageError);
  await assert.rejects(store.getTransaction('t'.repeat(43)), OAuthStorageError);
  assert.deepEqual(requests, [], 'nothing was read from the cached endpoint');
});

test('a read with no etag is a storage failure, so compare-and-swap never runs blind', async () => {
  setContext({ siteID: 'site', token: 'blobs-token', edgeURL: EDGE, uncachedEdgeURL: UNCACHED });
  answer(200, JSON.stringify({ id: 'g1', revoked: null }));

  await assert.rejects(new BlobsOAuthStore().getGrant('g1'), OAuthStorageError);
});

test('a missing record reads as null, not as an error', async () => {
  setContext({ siteID: 'site', token: 'blobs-token', edgeURL: EDGE, uncachedEdgeURL: UNCACHED });
  answer(404);

  assert.equal(await new BlobsOAuthStore().getGrant('absent'), null);
});

test('a store that refuses the request is a storage failure', async () => {
  setContext({ siteID: 'site', token: 'blobs-token', edgeURL: EDGE, uncachedEdgeURL: UNCACHED });
  answer(401, 'unauthorized');

  await assert.rejects(new BlobsOAuthStore().getGrant('g1'), OAuthStorageError);
});
