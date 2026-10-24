import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.OAUTH_ISSUER = 'https://mcp.example.com';
process.env.JWE_SECRET = 'test-only-pagination-secret-at-least-32-chars';

const mcp = (await import('../mcp.ts')).default;

beforeEach(() => {
  for (const method of ['log', 'warn', 'error'] as const) {
    mock.method(console, method, () => {});
  }
});
afterEach(() => mock.restoreAll());

const sites = (start: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `site-${start + index}`,
    name: `project-${start + index}`,
    account_id: 'team-one',
    url: `https://project-${start + index}.netlify.app`,
  }));

type Surface = 'grouped' | 'granular';

async function callTool(surface: Surface, operation: string, params: Record<string, unknown>) {
  const response = await mcp(
    new Request('https://mcp.example.com/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer nfp_pagination_test',
        'mcp-protocol-version': '2025-11-25',
        'user-agent': surface === 'granular' ? 'openai-mcp/1.0.0' : 'test-client',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name:
            surface === 'granular'
              ? `netlify-project-${operation}`
              : `netlify-project-services-${operation === 'get-projects' ? 'reader' : 'updater'}`,
          arguments: surface === 'granular' ? params : { selectSchema: { operation, params } },
        },
      }),
    }),
    {} as any,
  );
  const text = await response.text();
  const framed = text.match(/^event: message\ndata: (.*)$/m);
  return { response, payload: JSON.parse(framed ? framed[1] : text) };
}

function readItems({ response, payload }: Awaited<ReturnType<typeof callTool>>) {
  assert.equal(response.status, 200);
  assert.equal(payload.error, undefined);
  assert.notEqual(payload.result.isError, true, JSON.stringify(payload));
  return JSON.parse(JSON.parse(payload.result.content[0].text));
}

for (const surface of ['grouped', 'granular'] as const) {
  test(`${surface}: project listing stops requesting pages after its 22-second budget`, async (t) => {
    let now = 1_000_000;
    const pages: string[] = [];
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === '/api/v1/user') return Response.json({ id: 'user-one' });
      assert.equal(url.pathname, '/api/v1/team-one/sites');
      const page = url.searchParams.get('page')!;
      pages.push(page);
      now += 22_001;
      return Response.json(page === '1' ? sites(1, 100) : sites(101, 1));
    });

    const result = readItems(await callTool(surface, 'get-projects', { teamSlug: 'team-one' }));

    assert.deepEqual(pages, ['1']);
    assert.deepEqual(
      result.map((site: { id: string }) => site.id),
      sites(1, 100).map((site) => site.id),
    );
    assert.equal(result[0].teamId, 'team-one');
  });

  test(`${surface}: project listing shares one time budget across all pages`, async (t) => {
    let now = 1_000_000;
    const pages: string[] = [];
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === '/api/v1/user') return Response.json({ id: 'user-one' });
      assert.equal(url.pathname, '/api/v1/team-one/sites');
      const page = url.searchParams.get('page')!;
      pages.push(page);
      now += 11_001;
      return Response.json(
        page === '1' ? sites(1, 100) : page === '2' ? sites(101, 100) : sites(201, 1),
      );
    });

    const result = readItems(await callTool(surface, 'get-projects', { teamSlug: 'team-one' }));

    assert.deepEqual(pages, ['1', '2']);
    assert.equal(result.length, 200);
    assert.equal(result[199].id, 'site-200');
  });

  test(`${surface}: project listing combines pages before the budget and preserves follow-up identifiers`, async (t) => {
    let now = 1_000_000;
    const queries: string[] = [];
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === '/api/v1/user') return Response.json({ id: 'user-one' });
      assert.equal(url.pathname, '/api/v1/sites');
      queries.push(url.search);
      now += 10_000;
      return Response.json(url.searchParams.get('page') === '1' ? sites(1, 100) : sites(101, 1));
    });

    const result = readItems(
      await callTool(surface, 'get-projects', { projectNameSearchValue: 'project' }),
    );

    assert.deepEqual(queries, [
      '?filter=all&sort_by=published_at&order_by=asc&name=project&page=1&per_page=100',
      '?filter=all&sort_by=published_at&order_by=asc&name=project&page=2&per_page=100',
    ]);
    assert.equal(result.length, 101);
    assert.deepEqual(result[0], {
      id: 'site-1',
      name: 'project-1',
      url: 'https://project-1.netlify.app',
      teamId: 'team-one',
    });
    assert.deepEqual(result[100], {
      id: 'site-101',
      name: 'project-101',
      url: 'https://project-101.netlify.app',
      teamId: 'team-one',
    });
  });

  test(`${surface}: project listing retains 100-item pages for teams with over 2000 projects`, async (t) => {
    const pages: number[] = [];
    const projects = sites(1, 2001);
    t.mock.method(Date, 'now', () => 1_000_000);
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === '/api/v1/user') return Response.json({ id: 'user-one' });
      assert.equal(url.pathname, '/api/v1/team-one/sites');
      const page = Number(url.searchParams.get('page'));
      const perPage = Number(url.searchParams.get('per_page') ?? 100);
      pages.push(page);
      return Response.json(projects.slice((page - 1) * perPage, page * perPage));
    });

    const result = readItems(await callTool(surface, 'get-projects', { teamSlug: 'team-one' }));

    assert.equal(result.length, 2001);
    assert.equal(result[2000].id, 'site-2001');
    assert.deepEqual(
      pages,
      Array.from({ length: 21 }, (_, index) => index + 1),
    );
  });

  test(`${surface}: an empty project page ends the list without another request`, async (t) => {
    let pages = 0;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === '/api/v1/user') return Response.json({ id: 'user-one' });
      assert.equal(url.pathname, '/api/v1/team-one/sites');
      pages++;
      assert.equal(pages, 1, 'an empty page must end pagination');
      return Response.json([]);
    });

    assert.deepEqual(
      readItems(await callTool(surface, 'get-projects', { teamSlug: 'team-one' })),
      [],
    );
    assert.equal(pages, 1);
  });

  test(`${surface}: a later-page failure does not return a successful partial project list`, async (t) => {
    const pages: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === '/api/v1/user') return Response.json({ id: 'user-one' });
      assert.equal(url.pathname, '/api/v1/team-one/sites');
      const page = url.searchParams.get('page')!;
      pages.push(page);
      return page === '1'
        ? Response.json(sites(1, 100))
        : Response.json({ message: 'upstream failure' }, { status: 500 });
    });

    const { response, payload } = await callTool(surface, 'get-projects', { teamSlug: 'team-one' });

    assert.deepEqual(pages, ['1', '2']);
    assert.equal(response.status, 200);
    assert.equal(payload.result.isError, true);
    assert.match(payload.result.content[0].text, /Failed to fetch API: 500/);
    assert.doesNotMatch(JSON.stringify(payload), /site-1/);
  });

  test(`${surface}: form-submission listing observes the same elapsed-time budget`, async (t) => {
    let now = 1_000_000;
    const pages: string[] = [];
    const submissions = Array.from({ length: 20 }, (_, index) => ({ id: `submission-${index}` }));
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === '/api/v1/user') return Response.json({ id: 'user-one' });
      assert.equal(url.pathname, '/api/v1/forms/form-one/submissions');
      assert.equal(url.searchParams.get('per_page'), '20');
      const page = url.searchParams.get('page')!;
      pages.push(page);
      now += 22_001;
      return Response.json(page === '1' ? submissions : [{ id: 'extra-submission' }]);
    });

    const result = readItems(
      await callTool(surface, 'manage-form-submissions', {
        action: 'get-submissions',
        formId: 'form-one',
        limit: 40,
      }),
    );

    assert.deepEqual(pages, ['1']);
    assert.deepEqual(result, submissions);
  });
}
