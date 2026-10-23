import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

process.env.OAUTH_ISSUER = 'https://netlify-mcp.netlify.app';
process.env.JWE_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

const requestWithBearer = (bearer: string) =>
  new Request('https://netlify-mcp.netlify.app/mcp', {
    headers: { Authorization: `Bearer ${bearer}` },
  });

test('an expired JWE bearer is an auth failure, not a thrown server error', async () => {
  const { getNetlifyAccessToken, userIsAuthenticated, NetlifyUnauthError } = await import('./api-networking.ts');
  const { createJWE } = await import('../../netlify/functions/mcp-server/utils.ts');

  const expired = await createJWE({ accessToken: 'nfp_test' }, '1s');
  await sleep(1500);

  await assert.rejects(getNetlifyAccessToken(requestWithBearer(expired)), NetlifyUnauthError);
  assert.equal(await userIsAuthenticated(requestWithBearer(expired)), false);
});

test('an undecryptable bearer is an auth failure, not a thrown server error', async () => {
  const { getNetlifyAccessToken, userIsAuthenticated, NetlifyUnauthError } = await import('./api-networking.ts');

  await assert.rejects(getNetlifyAccessToken(requestWithBearer('not-a-jwe')), NetlifyUnauthError);
  assert.equal(await userIsAuthenticated(requestWithBearer('not-a-jwe')), false);
});

test('the deploy proxy returns 401 (not a crash) for an expired token', async () => {
  const { handleProxy } = await import('../../netlify/edge-functions/proxy.ts');
  const { createJWE } = await import('../../netlify/functions/mcp-server/utils.ts');

  const expired = await createJWE({ accessToken: 'nfp_test' }, '1s');
  await sleep(1500);

  const resp = await handleProxy(
    new Request(`https://netlify-mcp.netlify.app/proxy/${expired}/api/v1/deploys/x`, { method: 'GET' }),
    expired,
  );
  assert.equal(resp.status, 401);
});

// --- 401 recording --------------------------------------------------------

const incoming = () => requestWithBearer('nfp_test');

// Answers every path with `status`. Returns the paths fetched.
const stubFetch = (status: number) => {
  const paths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    paths.push(new URL(String(input)).pathname);
    return new Response('{"msg":"no"}', { status });
  }) as typeof fetch;
  return paths;
};

const withStub = async (fn: () => Promise<void>) => {
  const originalFetch = globalThis.fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  }
};

test('remote 401 records the 401 with its path, warns, and makes no /user call', async () => {
  const { authenticatedFetch } = await import('./api-networking.ts');
  const { log } = await import('../../netlify/functions/mcp-server/logger.ts');
  const { withRequestSignals, getNetlify401 } = await import('../../netlify/functions/mcp-server/request-signals.ts');
  await withStub(async () => {
    const paths = stubFetch(401);
    const warn = mock.method(log, 'warn', () => {});
    await withRequestSignals(async () => {
      const res = await authenticatedFetch('/api/v1/sites', {}, incoming());
      assert.equal(res.status, 401);
      assert.deepEqual(getNetlify401(), { path: '/api/v1/sites' });
      assert.deepEqual(paths, ['/api/v1/sites']);
      assert.equal(warn.mock.callCount(), 1);
    });
  });
});

test('quietStatuses [401] still records the 401 but logs at debug instead of warn', async () => {
  const { authenticatedFetch } = await import('./api-networking.ts');
  const { log } = await import('../../netlify/functions/mcp-server/logger.ts');
  const { withRequestSignals, getNetlify401 } = await import('../../netlify/functions/mcp-server/request-signals.ts');
  await withStub(async () => {
    stubFetch(401);
    const warn = mock.method(log, 'warn', () => {});
    const debug = mock.method(log, 'debug', () => {});
    await withRequestSignals(async () => {
      await authenticatedFetch('/api/v1/sites', {}, incoming(), [401]);
      assert.equal(warn.mock.callCount(), 0);
      assert.equal(debug.mock.callCount(), 1);
      assert.deepEqual(getNetlify401(), { path: '/api/v1/sites' });
    });
  });
});

test('a local 401 makes no /user call and records nothing', async () => {
  const { authenticatedFetch } = await import('./api-networking.ts');
  const { withRequestSignals, getNetlify401 } = await import('../../netlify/functions/mcp-server/request-signals.ts');
  await withStub(async () => {
    process.env.NETLIFY_PERSONAL_ACCESS_TOKEN = 'nfp_local';
    try {
      const paths = stubFetch(401);
      await withRequestSignals(async () => {
        const res = await authenticatedFetch('/api/v1/sites');
        assert.equal(res.status, 401);
        assert.deepEqual(paths, ['/api/v1/sites']);
        assert.equal(getNetlify401(), undefined);
      });
    } finally {
      delete process.env.NETLIFY_PERSONAL_ACCESS_TOKEN;
    }
  });
});

test('userIsAuthenticated keeps its expected 401 at debug', async () => {
  const { userIsAuthenticated } = await import('./api-networking.ts');
  const { log } = await import('../../netlify/functions/mcp-server/logger.ts');
  const { withRequestSignals } = await import('../../netlify/functions/mcp-server/request-signals.ts');
  await withStub(async () => {
    stubFetch(401);
    const warn = mock.method(log, 'warn', () => {});
    await withRequestSignals(async () => {
      assert.equal(await userIsAuthenticated(incoming()), false);
      assert.equal(warn.mock.callCount(), 0);
    });
  });
});

test('getAPIJSONResult: a remote 401 is a NetlifyApiError(401), not a NetlifyUnauthError', async () => {
  const { getAPIJSONResult, NetlifyApiError, NetlifyUnauthError } = await import('./api-networking.ts');
  const { withRequestSignals } = await import('../../netlify/functions/mcp-server/request-signals.ts');
  await withStub(async () => {
    const paths = stubFetch(401);
    await withRequestSignals(async () => {
      const err = await getAPIJSONResult('/api/v1/sites', {}, {}, incoming()).then(() => null, (e: unknown) => e);
      assert.ok(err instanceof NetlifyApiError);
      assert.ok(!(err instanceof NetlifyUnauthError));
      assert.equal(err.status, 401);
      assert.deepEqual(paths, ['/api/v1/sites']);
    });
  });
});
