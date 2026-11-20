// Drives the REAL handler (netlify/functions/mcp.ts): a 401 from a Netlify call
// inside a tool becomes an OAuth challenge only when one /user check, made after
// the tool, confirms the token is bad. The tool here is netlify-user-services-reader,
// whose only Netlify call is /user, so each request makes up to three /user calls
// in order: the up-front gate, the tool's own call, then the handler's check.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.OAUTH_ISSUER = 'https://mcp.example.com';
process.env.JWE_SECRET = 'test-only-auth-jwe-secret-at-least-32-chars';
process.env.EVENTS_RELAY_JWE_SECRET = 'test-only-events-relay-secret-at-least-32-chars';

type Step = (() => Response | Promise<Response>) | number;
type UserCall = { url: string; authorization: string | null; signal: AbortSignal | null | undefined };

let userCalls: UserCall[] = [];
let steps: Step[] = [];
// Extra 401s recorded during the tool's own /user call, to prove only one check runs.
let extra401Paths: string[] = [];

const { flagNetlify401 } = await import('./request-signals.ts');

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  const url = String(input?.url ?? input);
  if (!url.includes('/api/v1/user')) return realFetch(input, init);

  const index = userCalls.length;
  userCalls.push({ url, authorization: new Headers(init?.headers).get('authorization'), signal: init?.signal });
  // Runs in the request's async context, like a second Netlify call inside the tool.
  if (index === 1) extra401Paths.forEach(p => flagNetlify401(p));

  const step = steps[index] ?? 200;
  if (typeof step === 'function') return step();
  return new Response(JSON.stringify({ id: 'u1' }), { status: step, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const mcp = (await import('../mcp.ts')).default;
const { createJWE } = await import('./utils.ts');

// warn lines go to console.warn, info to console.log; capture both.
const origLog = console.log;
const origWarn = console.warn;
let logged: string[] = [];
before(() => {
  console.log = (line: unknown) => { logged.push(String(line)); };
  console.warn = (line: unknown) => { logged.push(String(line)); };
});
after(() => { console.log = origLog; console.warn = origWarn; globalThis.fetch = realFetch; });
beforeEach(() => { logged = []; userCalls = []; steps = []; extra401Paths = []; });

function loggedEntries(message: string) {
  return logged
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line))
    .filter(entry => entry.message.startsWith(message));
}

// A 2026-07-28 request, which the handler answers as plain JSON after the tool
// has run. (A 2025-era request streams its reply, so the tool can still be
// running when the handler regains control.)
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

async function toolCall() {
  const token = await createJWE({ accessToken: 'nfp_test_token', identity: { userId: 'u1', teamId: 't1' } }, '1h');
  return mcp(new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'netlify-user-services-reader',
      'user-agent': 'claude-code/2.1.0 (cli)',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'tools/call', id: 1,
      params: { _meta: ENVELOPE, name: 'netlify-user-services-reader', arguments: { selectSchema: { operation: 'get-user' } } },
    }),
  }), {} as any);
}

function assertChallenged(response: Response) {
  assert.equal(response.status, 401);
  assert.match(response.headers.get('WWW-Authenticate') ?? '', /error="invalid_token"/);
}

function assertPassedThrough(response: Response) {
  assert.equal(response.status, 200, 'the tool result should come back as-is');
  assert.equal(response.headers.get('WWW-Authenticate'), null);
}

test('a tool 401 plus a /user 401 issues the OAuth challenge', async () => {
  steps = [200, 401, 401];
  assertChallenged(await toolCall());
  assert.equal(userCalls.length, 3);
  const [entry] = loggedEntries('netlify api returned 401 during tool execution');
  assert.equal(entry.apiPath, '/api/v1/user');
});

test('a tool 401 plus a /user 200 passes the tool result through', async () => {
  steps = [200, 401, 200];
  assertPassedThrough(await toolCall());
  const [entry] = loggedEntries('netlify api returned 401 during tool execution');
  assert.equal(entry.outcome, 'token-valid');
  assert.equal(entry.apiPath, '/api/v1/user');
});

for (const status of [500, 503, 429, 403]) {
  test(`a tool 401 plus a /user ${status} passes through as inconclusive`, async () => {
    steps = [200, 401, status];
    assertPassedThrough(await toolCall());
    const [entry] = loggedEntries('netlify api returned 401 during tool execution');
    assert.equal(entry.outcome, 'inconclusive');
  });
}

test('a tool 401 plus a thrown /user error passes through as inconclusive', async () => {
  steps = [200, 401, () => { throw new TypeError('fetch failed'); }];
  assertPassedThrough(await toolCall());
  const [entry] = loggedEntries('netlify api returned 401 during tool execution');
  assert.equal(entry.outcome, 'inconclusive');
});

test('a tool 401 plus a /user timeout passes through as inconclusive', async () => {
  steps = [200, 401, () => { throw new DOMException('The operation timed out.', 'TimeoutError'); }];
  assertPassedThrough(await toolCall());
  const [entry] = loggedEntries('netlify api returned 401 during tool execution');
  assert.equal(entry.outcome, 'inconclusive');
});

test('the /user check is bounded by a timeout signal', async () => {
  steps = [200, 401, 200];
  await toolCall();
  assert.ok(userCalls[2].signal instanceof AbortSignal, 'the check should carry an abort signal');
});

test('no 401 means no /user call after the tool runs', async () => {
  steps = [200, 200];
  assertPassedThrough(await toolCall());
  assert.equal(userCalls.length, 2, 'only the gate and the tool call /user');
  assert.equal(loggedEntries('netlify api returned 401 during tool execution').length, 0);
});

test('several 401s in one request cause exactly one /user check', async () => {
  steps = [200, 401, 401];
  extra401Paths = ['/api/v1/sites', '/api/v1/accounts'];
  assertChallenged(await toolCall());
  assert.equal(userCalls.length, 3, 'gate, tool call, and a single check');
  const entries = loggedEntries('netlify api returned 401 during tool execution');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].apiPath, '/api/v1/sites', 'the first 401 recorded is the one reported');
});

test('the /user check sends the same bearer token to api.netlify.com', async () => {
  steps = [200, 401, 200];
  await toolCall();
  const check = userCalls[2];
  assert.equal(new URL(check.url).host, 'api.netlify.com');
  assert.equal(new URL(check.url).pathname, '/api/v1/user');
  assert.equal(check.authorization, 'Bearer nfp_test_token');
  assert.equal(userCalls[1].authorization, check.authorization, 'same token as the tool call');
});
