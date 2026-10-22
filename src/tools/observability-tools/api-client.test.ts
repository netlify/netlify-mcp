import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { withRequestSignals, getAuthChallenge } from '../../../netlify/functions/mcp-server/request-signals.ts';
import { NetlifyApiError, NetlifyUnauthError } from '../../utils/api-networking.ts';
import { getLists, OUT_OF_BOUNDS_MSG } from './api-client.ts';

// A raw PAT bearer is used as-is, so no JWE secret or decryption is involved.
const incoming = () =>
  new Request('https://netlify-mcp.netlify.app/mcp', {
    headers: { Authorization: 'Bearer nfp_test' },
  });

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const stubFetch = (status: number, body: string) => {
  globalThis.fetch = (async () =>
    new Response(body, { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
};

const callLists = () =>
  getLists('site-123', 1, 2, { name: 'edge_requests_logs', page: 1, per_page: 1 }, incoming());

test('a 401 "requested window out of bounds" is a client error with guidance, not an auth challenge', async () => {
  stubFetch(401, JSON.stringify({ code: 401, msg: OUT_OF_BOUNDS_MSG, error_id: 'x' }));

  await withRequestSignals(async () => {
    const err = await callLists().then(() => null, (e: unknown) => e);
    assert.ok(err instanceof NetlifyApiError, `expected NetlifyApiError, got ${String(err)}`);
    assert.equal(err.status, 401);
    assert.match(err.message, /requested window out of bounds/);
    assert.match(err.message, /retention/);
    // The dispatcher classifies NetlifyApiError < 500 as a warning; this is the
    // bit that keeps plan-limit rejections out of the failure-rate monitor.
    assert.ok(err.status < 500);
    // And the handler must not turn this into an OAuth re-auth challenge.
    assert.equal(getAuthChallenge(), undefined);
  });
});

test('any other 401 is still an auth failure and flags the OAuth challenge', async () => {
  stubFetch(401, JSON.stringify({ code: 401, msg: 'Unauthorized' }));

  await withRequestSignals(async () => {
    await assert.rejects(callLists(), NetlifyUnauthError);
    assert.deepEqual(getAuthChallenge(), { errorDescription: 'The Netlify access token is no longer valid' });
  });
});

test('a 401 whose body cannot be read is still an auth failure with the challenge flagged', async () => {
  globalThis.fetch = (async () => {
    const response = new Response('', { status: 401 });
    response.text = async () => { throw new Error('socket closed mid-body'); };
    return response;
  }) as typeof fetch;

  await withRequestSignals(async () => {
    await assert.rejects(callLists(), NetlifyUnauthError);
    assert.deepEqual(getAuthChallenge(), { errorDescription: 'The Netlify access token is no longer valid' });
  });
});

test('a 404 is a NetlifyApiError carrying the status and API message', async () => {
  stubFetch(404, JSON.stringify({ code: 404, msg: 'site not found' }));

  await withRequestSignals(async () => {
    const err = await callLists().then(() => null, (e: unknown) => e);
    assert.ok(err instanceof NetlifyApiError);
    assert.equal(err.status, 404);
    assert.match(err.message, /HTTP 404.*site not found/);
    assert.equal(getAuthChallenge(), undefined);
  });
});

test('a 5xx is a NetlifyApiError with status >= 500 so the dispatcher logs it as a failure', async () => {
  stubFetch(502, 'bad gateway');

  const err = await callLists().then(() => null, (e: unknown) => e);
  assert.ok(err instanceof NetlifyApiError);
  assert.equal(err.status, 502);
  assert.match(err.message, /HTTP 502/);
});

test('a 200 returns the parsed body', async () => {
  stubFetch(200, JSON.stringify({ data: [], meta: { responses: [] } }));
  const result = await callLists();
  assert.deepEqual(result, { data: [], meta: { responses: [] } });
});
