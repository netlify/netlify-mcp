import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NetlifyAgentRunnerSnapshotResponse } from '../../utils/api-types.ts';

const testRequest = () =>
  new Request('https://netlify-mcp.netlify.app/mcp', {
    headers: { Authorization: 'Bearer nfp_test_token' },
  });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const snapshot = (overrides: NetlifyAgentRunnerSnapshotResponse = {}): NetlifyAgentRunnerSnapshotResponse => ({
  activity_state: 'idle',
  agent_runner: { id: 'run-1', site_id: 'site-1', site_name: 'my-site', state: 'done', title: 'A run' },
  sessions: [{ id: 'sess-1', state: 'done', mode: 'normal' }],
  ...overrides,
});

test('summarizeRun reports an active run as still working', async () => {
  const { summarizeRun } = await import('./agent-runner-utils.ts');

  const summary = summarizeRun(
    snapshot({
      activity_state: 'active',
      agent_runner: { id: 'run-1', state: 'running', current_task: 'Editing the header' },
      sessions: [{ id: 'sess-1', state: 'running', mode: 'normal' }],
    }),
  );

  assert.equal(summary.activity, 'active');
  assert.equal(summary.currentTask, 'Editing the header');
  assert.match(summary.nextStep, /still working: Editing the header/);
  assert.match(summary.nextStep, /Do not call get-run repeatedly/);
});

test('summarizeRun surfaces the pending question on an await_input session', async () => {
  const { summarizeRun } = await import('./agent-runner-utils.ts');

  const questions = [{ question: 'Which color?', options: ['red', 'blue'] }];
  const summary = summarizeRun(
    snapshot({
      agent_runner: { id: 'run-1', state: 'await_input', site_name: 'my-site' },
      sessions: [
        { id: 'sess-0', state: 'done' },
        {
          id: 'sess-1',
          state: 'await_input',
          interactions: {
            'ref-old': { type: 'question', status: 'answered', payload: [] },
            'ref-2': { type: 'question', status: 'pending', payload: questions },
          },
        },
      ],
    }),
  );

  assert.deepEqual(summary.pendingQuestion, { sessionId: 'sess-1', refId: 'ref-2', type: 'question', questions });
  assert.match(summary.nextStep, /answer-run-question/);
});

test('summarizeRun sends an authorization request to the dashboard', async () => {
  const { summarizeRun } = await import('./agent-runner-utils.ts');

  const summary = summarizeRun(
    snapshot({
      agent_runner: { id: 'run-1', state: 'await_input', site_name: 'my-site' },
      sessions: [
        { id: 'sess-1', state: 'await_input', interactions: { 'ref-1': { type: 'authorization', status: 'pending' } } },
      ],
    }),
  );

  assert.deepEqual(summary.pendingQuestion?.questions, []);
  assert.match(summary.nextStep, /connect a service/);
});

test('summarizeRun surfaces the answer for a done ask-mode run', async () => {
  const { summarizeRun } = await import('./agent-runner-utils.ts');

  const summary = summarizeRun(
    snapshot({ sessions: [{ id: 'sess-1', state: 'done', mode: 'ask', result: 'It uses Astro.' }] }),
  );

  assert.equal(summary.latestSession?.result, 'It uses Astro.');
  assert.match(summary.nextStep, /Relay latestSession\.result/);
});

test('summarizeRun surfaces the preview for a done change-mode run', async () => {
  const { summarizeRun } = await import('./agent-runner-utils.ts');

  const fromRunner = summarizeRun(
    snapshot({
      agent_runner: { id: 'run-1', state: 'done', latest_session_deploy_url: 'https://deploy--my-site.netlify.app' },
    }),
  );
  assert.equal(fromRunner.previewUrl, 'https://deploy--my-site.netlify.app');
  assert.match(fromRunner.nextStep, /Share previewUrl/);

  const fromSession = summarizeRun(
    snapshot({ sessions: [{ id: 'sess-1', state: 'done', mode: 'normal', deploy_url: 'https://session--my-site.netlify.app' }] }),
  );
  assert.equal(fromSession.previewUrl, 'https://session--my-site.netlify.app');
});

test('summarizeRun builds the dashboard url from the site name and is null without one', async () => {
  const { summarizeRun } = await import('./agent-runner-utils.ts');

  assert.equal(summarizeRun(snapshot()).dashboardUrl, 'https://app.netlify.com/projects/my-site/agent-runs/run-1');
  assert.equal(
    summarizeRun(snapshot({ agent_runner: { id: 'run-1', state: 'done' } })).dashboardUrl,
    null,
  );
});

test('summarizeRun explains an ended run with the interrupt reason and credit message', async () => {
  const { summarizeRun } = await import('./agent-runner-utils.ts');

  const summary = summarizeRun(
    snapshot({
      agent_runner: { id: 'run-1', state: 'interrupted', site_name: 'my-site' },
      sessions: [
        {
          id: 'sess-1',
          state: 'interrupted',
          interrupt_reason: 'credit_limit',
          credit_limit_exceeded_message: 'Out of credits.',
        },
      ],
    }),
  );

  assert.match(summary.nextStep, /interrupted/);
  assert.match(summary.nextStep, /credit_limit/);
  assert.match(summary.nextStep, /Out of credits\./);
  assert.equal(summarizeRun(snapshot({ agent_runner: { id: 'run-1', state: 'archived' } })).nextStep, 'This run is archived.');
});

test('get-run fetches the snapshot with the run id encoded and returns the summary', async (t) => {
  const { getRunDomainTool } = await import('./get-run.ts');

  const fetchMock = t.mock.method(globalThis, 'fetch', async () => json(snapshot()));

  const result = await getRunDomainTool.cb({ runId: 'run/1?x=y' }, { request: testRequest() });

  const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit | undefined];
  assert.equal(String(url), 'https://api.netlify.com/api/v1/agent_runners/run%2F1%3Fx%3Dy/snapshot');
  assert.ok(!init?.method || init.method === 'GET');
  const parsed = JSON.parse(result);
  assert.equal(parsed.runId, 'run-1');
  assert.equal(parsed.dashboardUrl, 'https://app.netlify.com/projects/my-site/agent-runs/run-1');
});

test('get-run returns the not-found message on a 404 instead of throwing', async (t) => {
  const { getRunDomainTool } = await import('./get-run.ts');

  t.mock.method(globalThis, 'fetch', async () => json({ error: 'internal detail' }, 404));

  const result = await getRunDomainTool.cb({ runId: 'run-1' }, { request: testRequest() });

  assert.match(result, /not enabled for this project/);
  assert.doesNotMatch(result, /internal detail/);
});

test('list-runs fetches the site first, then lists with site_id, account_id and per_page', async (t) => {
  const { listRunsDomainTool } = await import('./list-runs.ts');

  const fetchMock = t.mock.method(globalThis, 'fetch', async (input: unknown) =>
    String(input).includes('/agent_runners')
      ? json([
          {
            id: 'run-1',
            title: 'A run',
            state: 'done',
            current_task: 'Done',
            created_at: '2026-10-07T00:00:00Z',
            latest_session_deploy_url: 'https://deploy--my-site.netlify.app',
            pr_url: 'https://github.com/o/r/pull/1',
          },
        ])
      : json({ id: 'site-1', name: 'my-site', account_id: 'acct-1' }),
  );

  const result = await listRunsDomainTool.cb({ siteId: 'site-1', state: 'done', limit: 5 }, { request: testRequest() });

  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal(String(fetchMock.mock.calls[0].arguments[0]), 'https://api.netlify.com/api/v1/sites/site-1');
  const listUrl = new URL(String(fetchMock.mock.calls[1].arguments[0]));
  assert.equal(listUrl.pathname, '/api/v1/agent_runners');
  assert.equal(listUrl.searchParams.get('site_id'), 'site-1');
  assert.equal(listUrl.searchParams.get('account_id'), 'acct-1');
  assert.equal(listUrl.searchParams.get('per_page'), '5');
  assert.equal(listUrl.searchParams.get('state'), 'done');
  assert.equal(listUrl.searchParams.has('page_size'), false);

  assert.deepEqual(JSON.parse(result), [
    {
      runId: 'run-1',
      title: 'A run',
      state: 'done',
      currentTask: 'Done',
      createdAt: '2026-10-07T00:00:00Z',
      previewUrl: 'https://deploy--my-site.netlify.app',
      prUrl: 'https://github.com/o/r/pull/1',
      dashboardUrl: 'https://app.netlify.com/projects/my-site/agent-runs/run-1',
    },
  ]);
});

test('list-runs defaults per_page to 20 and omits state', async (t) => {
  const { listRunsDomainTool } = await import('./list-runs.ts');

  const fetchMock = t.mock.method(globalThis, 'fetch', async (input: unknown) =>
    String(input).includes('/agent_runners') ? json([]) : json({ id: 'site-1', name: 'my-site', account_id: 'acct-1' }),
  );

  const result = await listRunsDomainTool.cb({ siteId: 'site-1' }, { request: testRequest() });

  const listUrl = new URL(String(fetchMock.mock.calls[1].arguments[0]));
  assert.equal(listUrl.searchParams.get('per_page'), '20');
  assert.equal(listUrl.searchParams.has('state'), false);
  assert.deepEqual(JSON.parse(result), []);
});

test('list-runs returns the not-found message when the project is missing and does not list', async (t) => {
  const { listRunsDomainTool } = await import('./list-runs.ts');

  const fetchMock = t.mock.method(globalThis, 'fetch', async () => json({}, 404));

  const result = await listRunsDomainTool.cb({ siteId: 'site-1' }, { request: testRequest() });

  assert.match(result, /not enabled for this project/);
  assert.equal(fetchMock.mock.callCount(), 1);
});

const failureCases: [string, number, unknown, RegExp][] = [
  ['404', 404, { error: 'raw secret detail' }, /not enabled for this project/],
  ['403 ai_credit_limit_disabled', 403, { error_code: 'ai_credit_limit_disabled' }, /credit limit on this team is set to 0/],
  ['403 other', 403, { error: 'Upgrade your plan' }, /plan can't use Agent Runners.*Upgrade your plan/],
  ['403 without a body', 403, undefined, /plan can't use Agent Runners/],
  ['409 active_session_exists', 409, { error_code: 'active_session_exists' }, /session is still running/],
  ['409 follow_up_unavailable', 409, { error_code: 'follow_up_unavailable' }, /published or is publishing/],
  ['429 ai_credit_limit_exceeded', 429, { error_code: 'ai_credit_limit_exceeded' }, /team is out of AI credits/],
  ['429 ai_credit_limit_reached', 429, { error_code: 'ai_credit_limit_reached' }, /personal AI credit limit/],
  ['429 other', 429, {}, /Too many runs are active/],
  ['422', 422, { error: 'prompt is too long' }, /can't continue as requested.*prompt is too long/],
  ['other', 500, { error: 'boom' }, /^Failed to start the run: 500$/],
  ['409 unknown code', 409, { error_code: 'something_else' }, /^Failed to start the run: 409$/],
];

for (const [name, status, body, expected] of failureCases) {
  test(`agentRunnerFailureMessage maps ${name}`, async () => {
    const { agentRunnerFailureMessage } = await import('./agent-runner-utils.ts');

    const response = new Response(body === undefined ? 'not json' : JSON.stringify(body), { status });
    const message = await agentRunnerFailureMessage(response, 'start the run');

    assert.match(message, expected);
    assert.doesNotMatch(message, /raw secret detail|\{/);
  });
}

test('toApiMode maps change to normal and leaves ask and create alone', async () => {
  const { toApiMode } = await import('./agent-runner-utils.ts');

  assert.equal(toApiMode('change'), 'normal');
  assert.equal(toApiMode('ask'), 'ask');
  assert.equal(toApiMode('create'), 'create');
});

const startRunInput = { siteId: 'site 1', prompt: 'Build a landing page', mode: 'change' as const };

test('start-run posts the prompt with the API mode for each mode', async (t) => {
  const { startRunDomainTool } = await import('./start-run.ts');

  const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
    json({ id: 'run-1', site_id: 'site 1', title: 'A run', state: 'new' }, 201),
  );

  for (const [mode, apiMode] of [['change', 'normal'], ['ask', 'ask'], ['create', 'create']] as const) {
    await startRunDomainTool.cb({ ...startRunInput, mode }, { request: testRequest() });
    const [url, init] = fetchMock.mock.calls.at(-1)!.arguments as [string, RequestInit];
    assert.equal(url, 'https://api.netlify.com/api/v1/agent_runners?site_id=site%201');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(String(init.body)), { prompt: 'Build a landing page', mode: apiMode });
  }
});

test('start-run passes branch and deploy_id when given and omits them otherwise', async (t) => {
  const { startRunDomainTool } = await import('./start-run.ts');

  const fetchMock = t.mock.method(globalThis, 'fetch', async () => json({ id: 'run-1' }, 201));

  await startRunDomainTool.cb({ ...startRunInput, branch: 'dev', deployId: 'deploy-1' }, { request: testRequest() });
  const body = JSON.parse(String((fetchMock.mock.calls[0].arguments[1] as RequestInit).body));
  assert.equal(body.branch, 'dev');
  assert.equal(body.deploy_id, 'deploy-1');

  await startRunDomainTool.cb(startRunInput, { request: testRequest() });
  const bare = JSON.parse(String((fetchMock.mock.calls[1].arguments[1] as RequestInit).body));
  assert.equal('branch' in bare, false);
  assert.equal('deploy_id' in bare, false);
});

test('start-run returns a compact summary of the new run', async (t) => {
  const { startRunDomainTool } = await import('./start-run.ts');

  t.mock.method(globalThis, 'fetch', async () =>
    json({ id: 'run-1', site_id: 'site-1', title: 'A run', state: 'new', secret: 'raw secret detail' }, 201),
  );

  const result = await startRunDomainTool.cb(startRunInput, { request: testRequest() });
  const parsed = JSON.parse(result);

  assert.deepEqual(Object.keys(parsed), ['runId', 'siteId', 'title', 'state', 'nextStep']);
  assert.equal(parsed.runId, 'run-1');
  assert.match(parsed.nextStep, /get-run/);
  assert.doesNotMatch(result, /raw secret detail/);
});

test('start-run does not throw when the success body cannot be read', async (t) => {
  const { startRunDomainTool } = await import('./start-run.ts');

  t.mock.method(globalThis, 'fetch', async () => new Response('not json', { status: 201 }));

  const result = await startRunDomainTool.cb(startRunInput, { request: testRequest() });

  assert.match(result, /list-runs/);
});

const startRunFailures: [string, number, unknown, RegExp][] = [
  ['403', 403, { error: 'Upgrade your plan' }, /plan can't use Agent Runners/],
  ['403 ai_credit_limit_disabled', 403, { error_code: 'ai_credit_limit_disabled' }, /credit limit on this team is set to 0/],
  ['404', 404, { error: 'raw secret detail' }, /not enabled for this project/],
  ['429 ai_credit_limit_exceeded', 429, { error_code: 'ai_credit_limit_exceeded' }, /team is out of AI credits/],
  ['429 ai_credit_limit_reached', 429, { error_code: 'ai_credit_limit_reached' }, /personal AI credit limit/],
  ['429 without a code', 429, {}, /Too many runs are active/],
];

for (const [name, status, body, expected] of startRunFailures) {
  test(`start-run returns the mapped message for ${name}`, async (t) => {
    const { startRunDomainTool } = await import('./start-run.ts');

    t.mock.method(globalThis, 'fetch', async () => json(body, status));

    const result = await startRunDomainTool.cb(startRunInput, { request: testRequest() });

    assert.match(result, expected);
    assert.doesNotMatch(result, /raw secret detail|\{/);
  });
}

test('start-run throws NetlifyUnauthError on a 401', async (t) => {
  const { startRunDomainTool } = await import('./start-run.ts');
  const { NetlifyUnauthError } = await import('../../utils/api-networking.ts');

  t.mock.method(globalThis, 'fetch', async () => json({}, 401));

  await assert.rejects(startRunDomainTool.cb(startRunInput, { request: testRequest() }), NetlifyUnauthError);
});

test('start-run carries the hand-off rule in its description and its prompt field', async () => {
  const { startRunDomainTool } = await import('./start-run.ts');
  const { HANDOFF_RULE } = await import('./agent-runner-utils.ts');

  assert.ok(startRunDomainTool.description?.includes(HANDOFF_RULE));
  assert.ok(startRunDomainTool.inputSchema.shape.prompt.description?.includes(HANDOFF_RULE));
});
