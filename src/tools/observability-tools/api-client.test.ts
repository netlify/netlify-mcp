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

// A 401 other than the retention limit makes the client re-check /api/v1/user,
// so the stub answers that path separately. Returns the paths fetched.
const stubFetch = (status: number, body: string, userStatus = 200) => {
  const paths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    return path === '/api/v1/user'
      ? new Response('{}', { status: userStatus })
      : new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return paths;
};

const callLists = () =>
  getLists('site-123', 1, 2, { name: 'edge_requests_logs', page: 1, per_page: 1 }, incoming());

test('a 401 "requested window out of bounds" is a client error with guidance, not an auth challenge', async () => {
  const paths = stubFetch(401, JSON.stringify({ code: 401, msg: OUT_OF_BOUNDS_MSG, error_id: 'x' }));

  await withRequestSignals(async () => {
    const err = await callLists().then(() => null, (e: unknown) => e);
    assert.ok(err instanceof NetlifyApiError, `expected NetlifyApiError, got ${String(err)}`);
    assert.equal(err.status, 401);
    assert.match(err.message, /requested window out of bounds/);
    assert.match(err.message, /retention/);
    assert.match(err.message, /to_ts/);
    assert.doesNotMatch(err.message, /Move from_ts later/);
    // The dispatcher classifies NetlifyApiError < 500 as a warning; this is the
    // bit that keeps plan-limit rejections out of the failure-rate monitor.
    assert.ok(err.status < 500);
    // And the handler must not turn this into an OAuth re-auth challenge.
    assert.equal(getAuthChallenge(), undefined);
    assert.ok(!paths.includes('/api/v1/user'), 'the retention limit needs no token re-check');
  });
});

test('the out-of-bounds match ignores casing and extra words', async () => {
  stubFetch(401, JSON.stringify({ code: 401, msg: 'Requested window out of bounds: from_ts too old' }));

  await withRequestSignals(async () => {
    const err = await callLists().then(() => null, (e: unknown) => e);
    assert.ok(err instanceof NetlifyApiError);
    assert.equal(err.status, 401);
    assert.match(err.message, /to_ts/);
    assert.equal(getAuthChallenge(), undefined);
  });
});

test('any other 401 with a still-valid token is a NetlifyApiError and does not flag the OAuth challenge', async () => {
  const paths = stubFetch(401, JSON.stringify({ code: 401, msg: 'Unauthorized' }));

  await withRequestSignals(async () => {
    const err = await callLists().then(() => null, (e: unknown) => e);
    assert.ok(err instanceof NetlifyApiError, `expected NetlifyApiError, got ${String(err)}`);
    assert.equal(err.status, 401);
    assert.match(err.message, /Unauthorized/);
    assert.equal(getAuthChallenge(), undefined);
    assert.ok(paths.includes('/api/v1/user'));
  });
});

test('a 401 after the token was revoked mid-request flags the OAuth challenge', async () => {
  stubFetch(401, JSON.stringify({ code: 401, msg: 'Unauthorized' }), 401);

  await withRequestSignals(async () => {
    await assert.rejects(callLists(), NetlifyUnauthError);
    assert.deepEqual(getAuthChallenge(), { errorDescription: 'The Netlify access token is no longer valid' });
  });
});

test('a 401 whose body cannot be read is a NetlifyApiError with no challenge flagged', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (new URL(String(input)).pathname === '/api/v1/user') return new Response('{}', { status: 200 });
    const response = new Response('', { status: 401 });
    response.text = async () => { throw new Error('socket closed mid-body'); };
    return response;
  }) as typeof fetch;

  await withRequestSignals(async () => {
    const err = await callLists().then(() => null, (e: unknown) => e);
    assert.ok(err instanceof NetlifyApiError, `expected NetlifyApiError, got ${String(err)}`);
    assert.equal(err.status, 401);
    assert.equal(getAuthChallenge(), undefined);
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

  await withRequestSignals(async () => {
    const err = await callLists().then(() => null, (e: unknown) => e);
    assert.ok(err instanceof NetlifyApiError);
    assert.equal(err.status, 502);
    assert.match(err.message, /HTTP 502/);
    assert.match(err.message, /bad gateway/);
    assert.equal(getAuthChallenge(), undefined);
  });
});

test('a JSON error body without msg keeps the raw detail', async () => {
  stubFetch(400, JSON.stringify({ message: 'invalid per_page' }));

  const err = await callLists().then(() => null, (e: unknown) => e);
  assert.ok(err instanceof NetlifyApiError);
  assert.equal(err.status, 400);
  assert.match(err.message, /invalid per_page/);
});

test('a long non-JSON error body is capped', async () => {
  stubFetch(502, 'x'.repeat(2000));

  const err = await callLists().then(() => null, (e: unknown) => e);
  assert.ok(err instanceof NetlifyApiError);
  assert.match(err.message, /x{500}\.\.\.$/);
  assert.doesNotMatch(err.message, /x{501}/);
});

test('a long JSON msg is capped', async () => {
  stubFetch(400, JSON.stringify({ code: 400, msg: 'y'.repeat(2000) }));

  const err = await callLists().then(() => null, (e: unknown) => e);
  assert.ok(err instanceof NetlifyApiError);
  assert.match(err.message, /y{500}\.\.\.$/);
  assert.doesNotMatch(err.message, /y{501}/);
});

test('a 200 returns the parsed body', async () => {
  stubFetch(200, JSON.stringify({ data: [], meta: { responses: [] } }));
  const result = await callLists();
  assert.deepEqual(result, { data: [], meta: { responses: [] } });
});
