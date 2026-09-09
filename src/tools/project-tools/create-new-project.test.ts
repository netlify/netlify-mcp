import { test } from 'node:test';
import assert from 'node:assert/strict';

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
