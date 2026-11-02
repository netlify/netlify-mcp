import { test } from 'node:test';
import assert from 'node:assert/strict';

const testRequest = () =>
  new Request('https://netlify-mcp.netlify.app/mcp', {
    headers: { Authorization: 'Bearer nfp_test_token' },
  });

// Stub the three calls an upsert of a new key makes: site lookup, existing-var
// lookup (404 = new key), then the create POST with the status under test.
const stubUpsert = (t: any, createStatus: number, createBody?: string, existingKey = false) => {
  const posted: { body?: any; posts: number; patchContexts: string[] } = { posts: 0, patchContexts: [] };
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/api/v1/sites/site-1')) {
      return new Response(JSON.stringify({ id: 'site-1', account_id: 'team-1' }), { status: 200 });
    }
    if (init?.method === 'POST') {
      posted.posts++;
      posted.body = JSON.parse(String(init.body))[0];
      return new Response(createBody ?? JSON.stringify({ code: createStatus, msg: 'nope' }), { status: createStatus });
    }
    if (init?.method === 'PATCH') {
      posted.patchContexts.push(JSON.parse(String(init.body)).context);
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (existingKey) {
      return new Response(JSON.stringify({ key: 'API_KEY', is_secret: true }), { status: 200 });
    }
    return new Response('', { status: 404 });
  });
  return posted;
};

const upsert = async (overrides: Record<string, unknown> = {}) => {
  const { manageEnvVarsDomainTool } = await import('./manage-project-env-vars.ts');
  return manageEnvVarsDomainTool.cb(
    { siteId: 'site-1', upsertEnvVar: true, envVarKey: 'API_KEY', envVarValue: 'v', newVarScopes: ['all'], newVarContext: 'all', ...overrides } as any,
    { request: testRequest() },
  );
};

test('a rejected env var create is an error, not "upserted"', async (t) => {
  const { NetlifyApiError } = await import('../../utils/api-networking.ts');
  for (const status of [401, 403, 422]) {
    stubUpsert(t, status);
    const err = await upsert().then(() => null, (e: unknown) => e);
    assert.ok(err instanceof NetlifyApiError, `status ${status}: expected NetlifyApiError, got ${String(err)}`);
    assert.equal(err.status, status);
  }
});

test('a refused create carries Netlify\'s reason and the key', async (t) => {
  const { NetlifyApiError } = await import('../../utils/api-networking.ts');
  stubUpsert(t, 403, JSON.stringify({ code: 403, msg: 'Upgrade your Netlify account to set specific scopes' }));
  const err = await upsert().then(() => null, (e: unknown) => e);
  assert.ok(err instanceof NetlifyApiError);
  assert.equal(err.status, 403);
  assert.match(err.message, /API_KEY/);
  assert.match(err.message, /Upgrade your Netlify account to set specific scopes/);
  assert.doesNotMatch(err.message, /"v"/);
});

test('a refused create with a non-JSON body keeps the default message', async (t) => {
  const { NetlifyApiError } = await import('../../utils/api-networking.ts');
  stubUpsert(t, 502, '');
  const err = await upsert().then(() => null, (e: unknown) => e);
  assert.ok(err instanceof NetlifyApiError);
  assert.equal(err.status, 502);
  assert.equal(err.message, 'Failed to fetch API: 502');
});

test('a successful env var create still reports upserted', async (t) => {
  stubUpsert(t, 201);
  assert.equal(await upsert(), 'Environment variable upserted');
});

test('a secret create with default scopes and context sends values the API accepts', async (t) => {
  const posted = stubUpsert(t, 201);
  const result = await upsert({ envVarIsSecret: true });
  assert.equal(posted.body.is_secret, true);
  assert.deepEqual(posted.body.scopes, ['builds', 'functions', 'runtime']);
  assert.deepEqual(posted.body.values, [
    { context: 'production', value: 'v' },
    { context: 'deploy-preview', value: 'v' },
    { context: 'branch-deploy', value: 'v' },
  ]);
  assert.equal(
    result,
    'Environment variable upserted as a secret (scopes: builds, functions, runtime; contexts: production, deploy-preview, branch-deploy)',
  );
});

test('a secret create with an explicit context and scopes sends them unchanged', async (t) => {
  const posted = stubUpsert(t, 201);
  const result = await upsert({ envVarIsSecret: true, newVarContext: 'production', newVarScopes: ['functions'] });
  assert.deepEqual(posted.body.scopes, ['functions']);
  assert.deepEqual(posted.body.values, [{ context: 'production', value: 'v' }]);
  assert.equal(result, 'Environment variable upserted');
});

test('a secret create with default scopes and an explicit context reports what was sent', async (t) => {
  const posted = stubUpsert(t, 201);
  const result = await upsert({ envVarIsSecret: true, newVarContext: 'production' });
  assert.deepEqual(posted.body.scopes, ['builds', 'functions', 'runtime']);
  assert.deepEqual(posted.body.values, [{ context: 'production', value: 'v' }]);
  assert.equal(result, 'Environment variable upserted as a secret (scopes: builds, functions, runtime; contexts: production)');
});

test('a secret create with explicit scopes and the default context reports what was sent', async (t) => {
  const posted = stubUpsert(t, 201);
  const result = await upsert({ envVarIsSecret: true, newVarScopes: ['functions'] });
  assert.deepEqual(posted.body.scopes, ['functions']);
  assert.deepEqual(posted.body.values, [
    { context: 'production', value: 'v' },
    { context: 'deploy-preview', value: 'v' },
    { context: 'branch-deploy', value: 'v' },
  ]);
  assert.equal(
    result,
    'Environment variable upserted as a secret (scopes: functions; contexts: production, deploy-preview, branch-deploy)',
  );
});

test('a refused create never echoes the submitted value', async (t) => {
  const { NetlifyApiError } = await import('../../utils/api-networking.ts');
  stubUpsert(t, 422, JSON.stringify({ code: 422, msg: 'Invalid value s3cr3t-value for API_KEY' }));
  const err = await upsert({ envVarValue: 's3cr3t-value' }).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof NetlifyApiError);
  assert.match(err.message, /\[redacted\]/);
  assert.doesNotMatch(err.message, /s3cr3t-value/);
});

test('a refused create does not leak a value that straddles the 300-character cutoff', async (t) => {
  const { NetlifyApiError } = await import('../../utils/api-networking.ts');
  const value = 'Zq7!xK9#mW2$pL5@';
  const msg = 'a'.repeat(290) + value.repeat(3);
  stubUpsert(t, 422, JSON.stringify({ code: 422, msg }));
  const err = await upsert({ envVarValue: value }).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof NetlifyApiError);
  for (let i = 0; i + 8 <= value.length; i++) {
    assert.ok(!err.message.includes(value.slice(i, i + 8)), `fragment at ${i} leaked`);
  }
  const reason = err.message.split('): ')[1];
  assert.ok(reason.length <= 300, `reason is ${reason.length} characters`);
});

test('upserting an existing secret key patches every context and never creates', async (t) => {
  const posted = stubUpsert(t, 201, undefined, true);
  const result = await upsert({ envVarIsSecret: true, newVarContext: 'all' });
  assert.equal(posted.posts, 0);
  assert.deepEqual(posted.patchContexts, ['dev', 'branch-deploy', 'deploy-preview', 'production', 'branch']);
  assert.equal(result, 'Environment variable upserted');
});

test('a non-secret create with defaults keeps all scopes and the all context', async (t) => {
  const posted = stubUpsert(t, 201);
  const result = await upsert();
  assert.equal(posted.body.is_secret, false);
  assert.deepEqual(posted.body.scopes, ['builds', 'functions', 'runtime', 'post_processing']);
  assert.deepEqual(posted.body.values, [{ context: 'all', value: 'v' }]);
  assert.equal(result, 'Environment variable upserted');
});

test('the tool description explains the secret and plan limits', async () => {
  const { manageEnvVarsDomainTool } = await import('./manage-project-env-vars.ts');
  const description = manageEnvVarsDomainTool.description ?? '';
  assert.match(description, /Pro/);
  assert.match(description, /post_processing/);
});
