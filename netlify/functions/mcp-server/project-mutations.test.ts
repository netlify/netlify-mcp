import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.OAUTH_ISSUER = 'http://localhost:8888';
process.env.JWE_SECRET = 'test-only-project-mutations-secret-32-chars';
process.env.EVENTS_RELAY_JWE_SECRET = 'test-only-project-events-secret-32-chars';

const mcp = (await import('../mcp.ts')).default;

interface APIExchange {
  method: string;
  path: string;
  body?: unknown;
  status?: number;
  reply?: unknown;
}

// Only the external Netlify API and documentation service are replaced. Tool
// registration, SDK validation, callbacks, and the API client run together.
function netlifyAPI(t: TestContext, exchanges: APIExchange[]) {
  const pending = [...exchanges];
  const failures: unknown[] = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    try {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.href === 'https://docs.netlify.com/ai-context/context-consumers') {
        return Response.json({ consumers: [{ key: 'netlify-mcp', contextScopes: {} }] });
      }
      assert.equal(url.origin, 'https://api.netlify.com');
      assert.equal(request.headers.get('authorization'), 'Bearer nfp_project_mutation_test');
      if (url.pathname === '/api/v1/user') return Response.json({ id: 'user-1' });

      const expected = pending.shift();
      assert.ok(expected, `Unexpected API request: ${request.method} ${url.pathname}`);
      assert.equal(request.method, expected.method);
      assert.equal(url.pathname + url.search, expected.path);
      const body = await request.text();
      assert.deepEqual(body ? JSON.parse(body) : undefined, expected.body);
      if (body) assert.equal(request.headers.get('content-type'), 'application/json');
      return new Response(expected.reply === undefined ? null : JSON.stringify(expected.reply), {
        status: expected.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      failures.push(error);
      throw error;
    }
  });
  t.after(() => {
    assert.deepEqual(failures, [], 'The API contract did not match');
    assert.equal(pending.length, 0, 'Expected API requests were not made');
  });
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

type Surface = 'grouped' | 'granular';

async function callTool(surface: Surface, operation: string, params: Record<string, unknown>) {
  const response = await mcp(new Request('http://localhost:8888/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer nfp_project_mutation_test',
      'mcp-protocol-version': '2025-11-25',
      'user-agent': surface === 'granular' ? 'openai-mcp/1.0.0' : 'test-client/1.0.0',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: surface === 'granular'
        ? { name: `netlify-project-${operation}`, arguments: params }
        : { name: 'netlify-project-services-updater', arguments: { selectSchema: { operation, params } } },
    }),
  }), {} as Parameters<typeof mcp>[1]);
  const text = await response.text();
  const framed = text.match(/^event: message\ndata: (.*)$/m);
  const body = JSON.parse(framed ? framed[1] : text);
  return { response, body };
}

function success(result: Awaited<ReturnType<typeof callTool>>): string {
  assert.equal(result.response.status, 200);
  assert.equal(result.body.error, undefined);
  const tool: ToolResult = result.body.result;
  assert.ok(tool);
  assert.notEqual(tool.isError, true, JSON.stringify(tool.content));
  assert.equal(tool.content[0].type, 'text');
  return JSON.parse(tool.content[0].text);
}

for (const surface of ['grouped', 'granular'] as const) {
  test(`${surface}: password protection keeps the requested deploy context and clears SSO`, async (t) => {
    netlifyAPI(t, [{
      method: 'PUT', path: '/api/v1/sites/site-1',
      body: { password: 'test-password', password_context: 'non_production', sso_login: false, sso_login_context: 'all' },
      reply: { id: 'site-1', name: 'test-site', has_password: true, password_context: 'non_production', sso_login: false },
    }]);
    const result = await callTool(surface, 'update-visitor-access-controls', {
      siteId: 'site-1', appliesTo: 'non-production-projects', requirePassword: true, passwordValue: 'test-password',
    });
    const [site] = JSON.parse(success(result));
    assert.deepEqual(site._enrichedFields.projectAccessControls, {
      requiresPassword: true, whichProjectsRequirePassword: 'non_production',
      requiresSSOTeamLogin: false, whichProjectsRequireSSOTeamLogin: null,
    });
  });
}

for (const surface of ['grouped', 'granular'] as const) {
  for (const [appliesTo, context] of [['all-projects', 'all'], ['non-production-projects', 'non_production']]) {
    test(`${surface}: SSO protection applies to ${appliesTo} and clears the password`, async (t) => {
      netlifyAPI(t, [{
        method: 'PUT', path: '/api/v1/sites/site-1',
        body: { password: '', password_context: 'all', sso_login: true, sso_login_context: context },
        reply: { id: 'site-1', sso_login: true, sso_login_context: context },
      }]);
      const result = await callTool(surface, 'update-visitor-access-controls', {
        siteId: 'site-1', appliesTo, requireSSOTeamLogin: true,
      });
      const [site] = JSON.parse(success(result));
      assert.equal(site._enrichedFields.projectAccessControls.requiresSSOTeamLogin, true);
      assert.equal(site._enrichedFields.projectAccessControls.whichProjectsRequireSSOTeamLogin, context);
    });
  }

  test(`${surface}: explicit false removes visitor protection`, async (t) => {
    netlifyAPI(t, [{
      method: 'PUT', path: '/api/v1/sites/site-1',
      body: { password: '', password_context: 'all', sso_login: false, sso_login_context: 'all' },
      reply: { id: 'site-1', has_password: false, sso_login: false },
    }]);
    const result = await callTool(surface, 'update-visitor-access-controls', {
      siteId: 'site-1', appliesTo: 'all-projects', requirePassword: false, requireSSOTeamLogin: false,
    });
    const [site] = JSON.parse(success(result));
    assert.equal(site._enrichedFields.projectAccessControls.requiresPassword, false);
    assert.equal(site._enrichedFields.projectAccessControls.requiresSSOTeamLogin, false);
  });

  for (const [params, message] of [
    [{}, 'You must provide either requireSSOTeamLogin or requirePassword'],
    [{ requirePassword: true }, 'You must provide a password value when requirePassword is true'],
  ] as const) {
    test(`${surface}: incomplete access change returns "${message}" without a write`, async (t) => {
      netlifyAPI(t, []);
      assert.equal(success(await callTool(surface, 'update-visitor-access-controls', {
        siteId: 'site-1', appliesTo: 'all-projects', ...params,
      })), message);
    });
  }

  test(`${surface}: rejected access update is an error, not a success`, async (t) => {
    netlifyAPI(t, [{
      method: 'PUT', path: '/api/v1/sites/site-1',
      body: { password: '', password_context: 'all', sso_login: true, sso_login_context: 'all' },
      status: 403, reply: { message: 'Forbidden' },
    }]);
    const result = await callTool(surface, 'update-visitor-access-controls', {
      siteId: 'site-1', appliesTo: 'all-projects', requireSSOTeamLogin: true,
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.result.isError, true);
    assert.match(result.body.result.content[0].text, /403/);
  });
}

for (const surface of ['grouped', 'granular'] as const) {
  test(`${surface}: creating an environment variable keeps the site, secret flag, scopes, and context`, async (t) => {
    netlifyAPI(t, [
      { method: 'GET', path: '/api/v1/sites/site-1', reply: { id: 'site-1', account_id: 'team-1' } },
      { method: 'GET', path: '/api/v1/accounts/team-1/env/SETTING?site_id=site-1', status: 404 },
      {
        method: 'POST', path: '/api/v1/accounts/team-1/env?site_id=site-1', status: 201,
        body: [{ key: 'SETTING', is_secret: true, scopes: ['functions'], values: [{ context: 'production', value: 'test-value' }] }],
      },
    ]);
    assert.equal(success(await callTool(surface, 'manage-env-vars', {
      siteId: 'site-1', upsertEnvVar: true, envVarKey: 'SETTING', envVarValue: 'test-value',
      envVarIsSecret: true, newVarScopes: ['functions'], newVarContext: 'production',
    })), 'Environment variable upserted');
  });

  test(`${surface}: updating one environment context preserves the existing variable metadata`, async (t) => {
    netlifyAPI(t, [
      { method: 'GET', path: '/api/v1/sites/site-1', reply: { id: 'site-1', account_id: 'team-1' } },
      { method: 'GET', path: '/api/v1/accounts/team-1/env/SETTING?site_id=site-1', reply: { key: 'SETTING', is_secret: true, scopes: ['functions'] } },
      {
        method: 'PATCH', path: '/api/v1/accounts/team-1/env/SETTING?site_id=site-1',
        body: { context: 'deploy-preview', value: 'preview-value' }, reply: { key: 'SETTING' },
      },
    ]);
    assert.equal(success(await callTool(surface, 'manage-env-vars', {
      siteId: 'site-1', upsertEnvVar: true, envVarKey: 'SETTING', envVarValue: 'preview-value',
      envVarIsSecret: false, newVarScopes: ['builds'], newVarContext: 'deploy-preview',
    })), 'Environment variable upserted');
  });

  test(`${surface}: an environment deletion stays scoped to the site's owning account`, async (t) => {
    netlifyAPI(t, [
      { method: 'GET', path: '/api/v1/sites/site-1', reply: { id: 'site-1', account_id: 'team-1' } },
      { method: 'DELETE', path: '/api/v1/accounts/team-1/env/SETTING?site_id=site-1', status: 204 },
    ]);
    assert.equal(success(await callTool(surface, 'manage-env-vars', {
      siteId: 'site-1', deleteEnvVar: true, envVarKey: 'SETTING',
    })), 'Environment variable deleted: SETTING');
  });

  test(`${surface}: a site without an owning account cannot mutate environment variables`, async (t) => {
    netlifyAPI(t, [{ method: 'GET', path: '/api/v1/sites/site-1', reply: { id: 'site-1' } }]);
    assert.equal(success(await callTool(surface, 'manage-env-vars', {
      siteId: 'site-1', deleteEnvVar: true, envVarKey: 'SETTING',
    })), 'This site id and the team it belongs to do not exist.');
  });

  test(`${surface}: a rejected environment update is an error`, async (t) => {
    netlifyAPI(t, [
      { method: 'GET', path: '/api/v1/sites/site-1', reply: { id: 'site-1', account_id: 'team-1' } },
      { method: 'GET', path: '/api/v1/accounts/team-1/env/SETTING?site_id=site-1', reply: { key: 'SETTING' } },
      { method: 'PATCH', path: '/api/v1/accounts/team-1/env/SETTING?site_id=site-1', body: { context: 'production', value: 'test-value' }, status: 403 },
    ]);
    const result = await callTool(surface, 'manage-env-vars', {
      siteId: 'site-1', upsertEnvVar: true, envVarKey: 'SETTING', envVarValue: 'test-value', newVarContext: 'production',
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.result.isError, true);
    assert.match(result.body.result.content[0].text, /403/);
  });
}

for (const surface of ['grouped', 'granular'] as const) {
  test(`${surface}: deleting a submission sends only the selected submission id and accepts an empty 204`, async (t) => {
    netlifyAPI(t, [{ method: 'DELETE', path: '/api/v1/submissions/submission-1', status: 204 }]);
    assert.equal(success(await callTool(surface, 'manage-form-submissions', {
      action: 'delete-submission', submissionId: 'submission-1', siteId: 'site-1', formId: 'form-1',
    })), 'Submission deleted');
  });

  test(`${surface}: deleting the same submission again surfaces the API's not-found response`, async (t) => {
    netlifyAPI(t, [
      { method: 'DELETE', path: '/api/v1/submissions/submission-1', status: 204 },
      { method: 'DELETE', path: '/api/v1/submissions/submission-1', status: 404 },
    ]);
    const params = { action: 'delete-submission', submissionId: 'submission-1' };
    assert.equal(success(await callTool(surface, 'manage-form-submissions', params)), 'Submission deleted');
    const result = await callTool(surface, 'manage-form-submissions', params);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.result.isError, true);
    assert.match(result.body.result.content[0].text, /404/);
  });

  test(`${surface}: a forbidden submission deletion reports an error`, async (t) => {
    netlifyAPI(t, [{ method: 'DELETE', path: '/api/v1/submissions/submission-1', status: 403 }]);
    const result = await callTool(surface, 'manage-form-submissions', {
      action: 'delete-submission', submissionId: 'submission-1',
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.result.isError, true);
    assert.match(result.body.result.content[0].text, /403/);
  });

  test(`${surface}: reading submissions uses the form id and schema pagination defaults`, async (t) => {
    const submissions = [{ id: 'submission-1', data: { name: 'Test sender' } }];
    netlifyAPI(t, [{ method: 'GET', path: '/api/v1/forms/form-1/submissions?page=1&page_size=20', reply: submissions }]);
    const result = await callTool(surface, 'manage-form-submissions', {
      action: 'get-submissions', formId: 'form-1', siteId: 'site-1',
    });
    assert.deepEqual(JSON.parse(success(result)), submissions);
  });

  test(`${surface}: a read without a form or site asks for the selector without calling the API`, async (t) => {
    netlifyAPI(t, []);
    assert.equal(success(await callTool(surface, 'manage-form-submissions', {
      action: 'get-submissions',
    })), 'Please provide a formId or siteId for selecting which form submissions to fetch');
  });

  test(`${surface}: an invalid submission action is rejected before calling the API`, async (t) => {
    netlifyAPI(t, []);
    const result = await callTool(surface, 'manage-form-submissions', {
      action: 'delete-all', submissionId: 'submission-1',
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.result.isError, true);
    assert.match(result.body.result.content[0].text, /validation|invalid/i);
  });
}

for (const surface of ['grouped', 'granular'] as const) {
  test(`${surface}: the default environment update stops and reports a partial failure`, async (t) => {
    netlifyAPI(t, [
      { method: 'GET', path: '/api/v1/sites/site-1', reply: { id: 'site-1', account_id: 'team-1' } },
      { method: 'GET', path: '/api/v1/accounts/team-1/env/SETTING?site_id=site-1', reply: { key: 'SETTING' } },
      { method: 'PATCH', path: '/api/v1/accounts/team-1/env/SETTING?site_id=site-1', body: { context: 'dev', value: 'test-value' }, reply: { key: 'SETTING' } },
      { method: 'PATCH', path: '/api/v1/accounts/team-1/env/SETTING?site_id=site-1', body: { context: 'branch-deploy', value: 'test-value' }, status: 403 },
    ]);
    const result = await callTool(surface, 'manage-env-vars', {
      siteId: 'site-1', upsertEnvVar: true, envVarKey: 'SETTING', envVarValue: 'test-value',
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.result.isError, true);
    assert.match(result.body.result.content[0].text, /403/);
  });
}
