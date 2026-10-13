import { after, before, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@netlify/functions';

process.env.OAUTH_ISSUER = 'https://mcp.example.com';
process.env.JWE_SECRET = 'test-only-auth-jwe-secret-at-least-32-chars';

const mcp = (await import('../mcp.ts')).default;
const originalLog = console.log;
before(() => {
  console.log = () => {};
});
after(() => {
  console.log = originalLog;
});

type APICall = { method: string; path: string; body: unknown };
type APIReply = (call: APICall) => Response | Promise<Response>;

function netlifyAPI(t: TestContext, reply: APIReply) {
  const calls: APICall[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.url === 'https://www.netlify.com/context-files/manifest.json') {
      return Response.json({ schema_version: 1, version: 'fixture', skills: [] });
    }
    assert.equal(url.origin, 'https://api.netlify.com');
    if (url.pathname === '/api/v1/user') return Response.json({ id: 'user-1' });
    const text = await request.text();
    const call = { method: request.method, path: url.pathname + url.search, body: text ? JSON.parse(text) : null };
    calls.push(call);
    if (call.path === '/api/v1/sites/site-1') return Response.json({ id: 'site-1', account_id: 'team-1' });
    return reply(call);
  });
  return calls;
}

async function callTool(surface: 'grouped' | 'granular', operation: string, params: Record<string, unknown>) {
  const response = await mcp(
    new Request('https://mcp.example.com/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer nfp_fixture_token',
        'mcp-protocol-version': '2025-11-25',
        'user-agent': surface === 'granular' ? 'openai-mcp/1.0.0' : 'test-client/1.0.0',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params:
          surface === 'granular'
            ? { name: `netlify-project-${operation}`, arguments: params }
            : { name: 'netlify-project-services-updater', arguments: { selectSchema: { operation, params } } },
      }),
    }),
    {} as Context,
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const frame = text.match(/^data: (.*)$/m);
  const message = JSON.parse(frame ? frame[1] : text);
  assert.ok(message.result, text);
  return message.result as { isError?: boolean; content: Array<{ type: string; text: string }> };
}

const envPath = '/api/v1/accounts/team-1/env/TEST_KEY?site_id=site-1';
const envParams = { siteId: 'site-1', upsertEnvVar: true, envVarKey: 'TEST_KEY', envVarValue: 'fixture-value' };

for (const surface of ['grouped', 'granular'] as const) {
  for (const body of ['', '<html>upstream error</html>']) {
    test(`${surface}: an invalid lookup body cannot trigger a write (${JSON.stringify(body)})`, async (t) => {
      const calls = netlifyAPI(t, ({ method, path }) => {
        if (method === 'GET' && path === envPath) return new Response(body);
        return Response.json({ key: 'TEST_KEY' });
      });
      const result = await callTool(surface, 'manage-env-vars', envParams);
      assert.equal(result.isError, true);
      assert.equal(
        calls.some((call) => call.method !== 'GET'),
        false,
      );
    });
  }

  for (const status of [401, 403, 429, 500]) {
    test(`${surface}: environment lookup ${status} cannot create a variable`, async (t) => {
      const calls = netlifyAPI(t, ({ method, path }) => {
        if (method === 'GET' && path === envPath) return new Response('lookup failed', { status });
        return Response.json([]);
      });
      const result = await callTool(surface, 'manage-env-vars', envParams);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, status === 401 ? /[Uu]nauth/ : new RegExp(String(status)));
      assert.equal(
        calls.some((call) => call.method !== 'GET'),
        false,
      );
    });
  }

  for (const status of [401, 403, 422, 429, 500]) {
    test(`${surface}: environment create ${status} is reported as an error`, async (t) => {
      const calls = netlifyAPI(t, ({ method, path }) => {
        if (method === 'GET' && path === envPath) return new Response(null, { status: 404 });
        if (method === 'POST' && path === '/api/v1/accounts/team-1/env?site_id=site-1') {
          return new Response('create failed', { status });
        }
        throw new Error(`Unexpected API call: ${method} ${path}`);
      });
      const result = await callTool(surface, 'manage-env-vars', envParams);
      assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, status === 401 ? /[Uu]nauth/ : new RegExp(String(status)));
      assert.doesNotMatch(result.content[0].text, /upserted/);
    });
  }

  test(`${surface}: a missing variable is created with the requested context, scopes and secret flag`, async (t) => {
    const calls = netlifyAPI(t, ({ method, path, body }) => {
      if (method === 'GET' && path === envPath) return new Response(null, { status: 404 });
      if (method === 'POST' && path === '/api/v1/accounts/team-1/env?site_id=site-1') {
        return Response.json(body, { status: 201 });
      }
      throw new Error(`Unexpected API call: ${method} ${path}`);
    });
    const result = await callTool(surface, 'manage-env-vars', {
      ...envParams,
      envVarIsSecret: true,
      newVarScopes: ['functions'],
      newVarContext: 'production',
    });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /Environment variable upserted/);
    assert.deepEqual(
      calls.filter((call) => call.method !== 'GET'),
      [
        {
          method: 'POST',
          path: '/api/v1/accounts/team-1/env?site_id=site-1',
          body: [
            {
              key: 'TEST_KEY',
              is_secret: true,
              scopes: ['functions'],
              values: [{ context: 'production', value: 'fixture-value' }],
            },
          ],
        },
      ],
    );
  });

  test(`${surface}: an existing variable updates only its requested context value`, async (t) => {
    const calls = netlifyAPI(t, ({ method, path }) => {
      assert.equal(path, envPath);
      assert.ok(method === 'GET' || method === 'PATCH');
      return Response.json({ key: 'TEST_KEY', is_secret: true, scopes: ['functions'], values: [] });
    });
    const result = await callTool(surface, 'manage-env-vars', {
      ...envParams,
      envVarValue: '',
      newVarContext: 'production',
    });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /Environment variable upserted/);
    assert.deepEqual(
      calls.filter((call) => call.method !== 'GET'),
      [
        {
          method: 'PATCH',
          path: envPath,
          body: { context: 'production', value: '' },
        },
      ],
    );
  });

  test(`${surface}: environment variables can still be listed without a key`, async (t) => {
    const variables = [{ key: 'TEST_KEY', scopes: ['functions'], values: [] }];
    const calls = netlifyAPI(t, ({ method, path }) => {
      assert.equal(method, 'GET');
      assert.equal(path, '/api/v1/sites/site-1/env');
      return Response.json(variables);
    });
    const result = await callTool(surface, 'manage-env-vars', { siteId: 'site-1', getAllEnvVars: true });
    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(JSON.parse(result.content[0].text)), variables);
    assert.equal(calls.length, 2);
  });

  test(`${surface}: an explicitly selected variable named undefined can still be deleted`, async (t) => {
    const calls = netlifyAPI(t, () => new Response(null, { status: 204 }));
    const result = await callTool(surface, 'manage-env-vars', {
      siteId: 'site-1',
      deleteEnvVar: true,
      envVarKey: 'undefined',
    });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /Environment variable deleted: undefined/);
    assert.deepEqual(
      calls.filter((call) => call.method !== 'GET'),
      [
        {
          method: 'DELETE',
          path: '/api/v1/accounts/team-1/env/undefined?site_id=site-1',
          body: null,
        },
      ],
    );
  });

  test(`${surface}: an explicitly selected form submission can still be deleted`, async (t) => {
    const calls = netlifyAPI(t, () => new Response(null, { status: 204 }));
    const result = await callTool(surface, 'manage-form-submissions', {
      action: 'delete-submission',
      submissionId: 'submission-1',
    });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /Submission deleted/);
    assert.deepEqual(calls, [{ method: 'DELETE', path: '/api/v1/submissions/submission-1', body: null }]);
  });

  for (const selector of [undefined, '', '   ']) {
    test(`${surface}: upserting an environment variable rejects selector ${JSON.stringify(selector)}`, async (t) => {
      const calls = netlifyAPI(t, () => new Response(null, { status: 204 }));
      const result = await callTool(surface, 'manage-env-vars', { ...envParams, envVarKey: selector });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /envVarKey/);
      assert.equal(calls.length, 0);
    });

    test(`${surface}: deleting an environment variable rejects selector ${JSON.stringify(selector)}`, async (t) => {
      const calls = netlifyAPI(t, () => new Response(null, { status: 204 }));
      const result = await callTool(surface, 'manage-env-vars', {
        siteId: 'site-1',
        deleteEnvVar: true,
        envVarKey: selector,
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /envVarKey/);
      assert.equal(calls.length, 0);
    });

    test(`${surface}: deleting a form submission rejects selector ${JSON.stringify(selector)}`, async (t) => {
      const calls = netlifyAPI(t, () => new Response(null, { status: 204 }));
      const result = await callTool(surface, 'manage-form-submissions', {
        action: 'delete-submission',
        submissionId: selector,
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /submissionId/);
      assert.equal(calls.length, 0);
    });
  }
}
