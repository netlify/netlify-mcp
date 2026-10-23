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

// --- 401 re-check ---------------------------------------------------------

const incoming = () => requestWithBearer('nfp_test');

// Routes /api/v1/user separately; `userStatus` of 'throw' makes it reject.
// Returns the paths fetched.
const stubFetch = (status: number, userStatus: number | 'throw' = 200) => {
  const paths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path === '/api/v1/user') {
      if (userStatus === 'throw') throw new TypeError('network down');
      return new Response('{}', { status: userStatus });
    }
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

test('remote 401 with a still-valid token is not an auth failure', async () => {
  const { authenticatedFetch, isAuthFailure } = await import('./api-networking.ts');
  const { withRequestSignals, getAuthChallenge } = await import('../../netlify/functions/mcp-server/request-signals.ts');
  await withStub(async () => {
    const paths = stubFetch(401, 200);
    await withRequestSignals(async () => {
      const res = await authenticatedFetch('/api/v1/sites', {}, incoming());
      assert.equal(res.status, 401);
      assert.equal(getAuthChallenge(), undefined);
      assert.equal(isAuthFailure(res), false);
      assert.deepEqual(paths, ['/api/v1/sites', '/api/v1/user']);
    });
  });
});

test('remote 401 with a rejected token flags the challenge', async () => {
  const { authenticatedFetch, isAuthFailure } = await import('./api-networking.ts');
  const { withRequestSignals, getAuthChallenge } = await import('../../netlify/functions/mcp-server/request-signals.ts');
  await withStub(async () => {
    stubFetch(401, 401);
    await withRequestSignals(async () => {
      const res = await authenticatedFetch('/api/v1/sites', {}, incoming());
      assert.equal(res.status, 401);
      assert.ok(getAuthChallenge());
      assert.equal(isAuthFailure(res), true);
    });
  });
});

test('a 401 on /api/v1/user flags the challenge without re-checking itself', async () => {
  const { authenticatedFetch } = await import('./api-networking.ts');
  const { withRequestSignals, getAuthChallenge } = await import('../../netlify/functions/mcp-server/request-signals.ts');
  await withStub(async () => {
    const paths = stubFetch(401, 401);
    await withRequestSignals(async () => {
      const res = await authenticatedFetch('/api/v1/user', {}, incoming());
      assert.equal(res.status, 401);
      assert.ok(getAuthChallenge());
      assert.deepEqual(paths, ['/api/v1/user']);
    });
  });
});

test('a failing re-check falls back to flagging and still returns the 401', async () => {
  const { authenticatedFetch } = await import('./api-networking.ts');
  const { withRequestSignals, getAuthChallenge } = await import('../../netlify/functions/mcp-server/request-signals.ts');
  await withStub(async () => {
    stubFetch(401, 'throw');
    await withRequestSignals(async () => {
      const res = await authenticatedFetch('/api/v1/sites', {}, incoming());
      assert.equal(res.status, 401);
      assert.ok(getAuthChallenge());
    });
  });
});

test('a local 401 makes no /user call and flags nothing', async () => {
  const { authenticatedFetch, isAuthFailure } = await import('./api-networking.ts');
  const { withRequestSignals, getAuthChallenge } = await import('../../netlify/functions/mcp-server/request-signals.ts');
  await withStub(async () => {
    process.env.NETLIFY_PERSONAL_ACCESS_TOKEN = 'nfp_local';
    try {
      const paths = stubFetch(401, 200);
      await withRequestSignals(async () => {
        const res = await authenticatedFetch('/api/v1/sites');
        assert.equal(res.status, 401);
        assert.deepEqual(paths, ['/api/v1/sites']);
        assert.equal(getAuthChallenge(), undefined);
        assert.equal(isAuthFailure(res), false);
      });
    } finally {
      delete process.env.NETLIFY_PERSONAL_ACCESS_TOKEN;
    }
  });
});

test('quietStatuses suppresses the warn for a non-auth 401, which warns otherwise', async () => {
  const { authenticatedFetch } = await import('./api-networking.ts');
  const { log } = await import('../../netlify/functions/mcp-server/logger.ts');
  const { withRequestSignals } = await import('../../netlify/functions/mcp-server/request-signals.ts');
  await withStub(async () => {
    stubFetch(401, 200);
    const warn = mock.method(log, 'warn', () => {});
    await withRequestSignals(async () => {
      await authenticatedFetch('/api/v1/sites', {}, incoming(), [401]);
      assert.equal(warn.mock.callCount(), 0);
      await authenticatedFetch('/api/v1/sites', {}, incoming());
      assert.equal(warn.mock.callCount(), 1);
    });
  });
});

test('getAPIJSONResult: a non-auth 401 is a NetlifyApiError, an auth 401 a NetlifyUnauthError', async () => {
  const { getAPIJSONResult, NetlifyApiError, NetlifyUnauthError } = await import('./api-networking.ts');
  const { withRequestSignals } = await import('../../netlify/functions/mcp-server/request-signals.ts');
  await withStub(async () => {
    stubFetch(401, 200);
    await withRequestSignals(async () => {
      const err = await getAPIJSONResult('/api/v1/sites', {}, {}, incoming()).then(() => null, (e: unknown) => e);
      assert.ok(err instanceof NetlifyApiError);
      assert.equal(err.status, 401);
    });
    stubFetch(401, 401);
    await withRequestSignals(async () => {
      await assert.rejects(getAPIJSONResult('/api/v1/sites', {}, {}, incoming()), NetlifyUnauthError);
    });
  });
});
