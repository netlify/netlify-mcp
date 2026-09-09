import { test } from 'node:test';
import assert from 'node:assert/strict';
import { log } from '../../../netlify/functions/mcp-server/logger.ts';

const testRequest = () =>
  new Request('https://netlify-mcp.netlify.app/mcp', {
    headers: { Authorization: 'Bearer nfp_test_token' },
  });

const bodyName = (init: RequestInit) => JSON.parse(init.body as string).name;

test('create-new-project retries with a random suffix and succeeds when the name is taken', async (t) => {
  const { createNewProjectDomainTool } = await import('./create-new-project.ts');

  const attemptedNames: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const name = bodyName(init);
    attemptedNames.push(name);
    if (name === 'taken-name') {
      return new Response(JSON.stringify({ message: 'name must be unique' }), { status: 422 });
    }
    return new Response(JSON.stringify({ id: 'site-1', name, account_id: 'acct-1' }), { status: 200 });
  });

  const result = await createNewProjectDomainTool.cb({ name: 'taken-name' }, { request: testRequest() });

  assert.equal(attemptedNames.length, 2, `expected exactly one retry, got attempts: ${attemptedNames.join(', ')}`);
  assert.ok(attemptedNames[1].startsWith('taken-name-'), `retry name should be suffixed, got: ${attemptedNames[1]}`);

  const parsed = JSON.parse(result);
  assert.match(parsed.followupForAgentsOnly, /taken-name.*wasn't available/);
  assert.match(parsed.followupForAgentsOnly, new RegExp(attemptedNames[1]));
  assert.equal(parsed.rawToolResponse[0].name, attemptedNames[1]);
});

test('create-new-project does not log a retryable 422, but does log the final one', async (t) => {
  const { createNewProjectDomainTool } = await import('./create-new-project.ts');

  const warnings: Array<[string, any]> = [];
  t.mock.method(log, 'warn', (message: string, fields: any) => {
    warnings.push([message, fields]);
  });
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ message: 'name must be unique' }), { status: 422 }),
  );

  await createNewProjectDomainTool.cb({ name: 'always-taken' }, { request: testRequest() });

  // 3 attempts (initial + 2 retries) but only the last — non-retryable — 422
  // should be logged as a failure; the first two were expected and retried.
  assert.equal(warnings.length, 1, `expected exactly one warn, got: ${JSON.stringify(warnings)}`);
  assert.equal(warnings[0][1].status, 422);
});

test('create-new-project still logs a non-422 failure even on a retryable attempt', async (t) => {
  const { createNewProjectDomainTool } = await import('./create-new-project.ts');

  const warnings: Array<[string, any]> = [];
  t.mock.method(log, 'warn', (message: string, fields: any) => {
    warnings.push([message, fields]);
  });
  t.mock.method(globalThis, 'fetch', async () => new Response('server error', { status: 500 }));

  const result = await createNewProjectDomainTool.cb({ name: 'whatever' }, { request: testRequest() });

  // A 500 isn't retried (only 422 name conflicts are), so it fails immediately
  // on the first attempt — and that failure is real, so it must still log.
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1].status, 500);
  assert.match(result, /Failed to create project: 500/);
});

test('create-new-project gives up gracefully after repeated conflicts, without throwing', async (t) => {
  const { createNewProjectDomainTool } = await import('./create-new-project.ts');

  let callCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    callCount++;
    return new Response(JSON.stringify({ message: 'name must be unique' }), { status: 422 });
  });

  const result = await createNewProjectDomainTool.cb({ name: 'always-taken' }, { request: testRequest() });

  // initial attempt + MAX_NAME_CONFLICT_RETRIES retries
  assert.equal(callCount, 3);
  assert.equal(typeof result, 'string');
  assert.match(result, /always-taken.*already taken/);
});

test('create-new-project does not retry when no name was requested', async (t) => {
  const { createNewProjectDomainTool } = await import('./create-new-project.ts');

  let callCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    callCount++;
    return new Response(JSON.stringify({ message: 'name must be unique' }), { status: 422 });
  });

  const result = await createNewProjectDomainTool.cb({}, { request: testRequest() });

  assert.equal(callCount, 1);
  assert.equal(typeof result, 'string');
  assert.match(result, /couldn't generate a unique project name/);
});

test('create-new-project succeeds on the first try when the name is free', async (t) => {
  const { createNewProjectDomainTool } = await import('./create-new-project.ts');

  let callCount = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    callCount++;
    return new Response(JSON.stringify({ id: 'site-1', name: bodyName(init), account_id: 'acct-1' }), { status: 200 });
  });

  const result = await createNewProjectDomainTool.cb({ name: 'free-name' }, { request: testRequest() });

  assert.equal(callCount, 1);
  const parsed = JSON.parse(result);
  assert.equal(parsed.rawToolResponse[0].name, 'free-name');
  assert.doesNotMatch(parsed.followupForAgentsOnly, /wasn't available/);
});
