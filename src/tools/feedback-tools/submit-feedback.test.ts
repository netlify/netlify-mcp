import { test } from 'node:test';
import assert from 'node:assert/strict';

// Needed by createJWE / the JWE identity path; set before those modules load.
process.env.JWE_SECRET ??= 'test-only-auth-jwe-secret-at-least-32-chars';

import { scrubFeedbackText } from './redact.ts';
import { claimDailySlot, setFeedbackStoreForTests, type FeedbackStore, type SlotStore } from './feedback-store.ts';
import {
  submitFeedbackDomainTool,
  MAX_FEEDBACK_PER_USER_PER_DAY,
  MAX_SUMMARY_CHARS,
  MAX_DETAILS_CHARS,
  MAX_SUGGESTION_CHARS,
  MAX_SHORT_FIELD_CHARS,
} from './submit-feedback.ts';
import { feedbackDomainTools } from './index.ts';
import { completeToolAnnotations } from '../tool-utils.ts';

const { createJWE } = await import('../../../netlify/functions/mcp-server/utils.ts');

const testRequest = (headers: Record<string, string> = {}) =>
  new Request('https://netlify-mcp.netlify.app/mcp', {
    headers: { Authorization: 'Bearer nfp_test_token', 'user-agent': 'test-agent/1.0', ...headers },
  });

// A Map-backed stand-in for Blobs with real `onlyIfNew` semantics. The await
// before each write lets concurrent calls interleave, as real requests would.
const memorySlotStore = () => {
  const saved = new Map<string, unknown>();
  const slotStore: SlotStore = {
    async list({ prefix }) {
      await Promise.resolve();
      return { blobs: [...saved.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) };
    },
    async setJSON(key, value) {
      await Promise.resolve();
      if (saved.has(key)) return { modified: false };
      saved.set(key, value);
      return { modified: true };
    },
  };
  return { slotStore, saved };
};

const useMemoryStore = (t: any) => {
  const { slotStore, saved } = memorySlotStore();
  const store: FeedbackStore = {
    saveInDailySlot: (day, userId, max, record) => claimDailySlot(slotStore, day, userId, max, record),
  };
  setFeedbackStoreForTests(store);
  t.after(() => setFeedbackStoreForTests(null));
  return saved as Map<string, Record<string, unknown>>;
};

const mockUser = (t: any, user: Record<string, unknown> = { id: 'user-1', account_id: 'team-1', email: 'someone@example.com' }) =>
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(user), { status: 200 }));

const captureLogs = (t: any) => {
  const lines: any[] = [];
  for (const stream of ['log', 'warn', 'error'] as const) {
    t.mock.method(console, stream, (line: string) => {
      try { lines.push(JSON.parse(line)); } catch { /* system-log copies */ }
    });
  }
  return lines;
};

const validInput = {
  category: 'netlify-mcp' as const,
  summary: 'Deploy tool output is hard to follow',
  details: 'The deploy tool returned a long JSON blob without a clear next step for the agent.',
};

// ---- Scrubbing ----

test('redacts credentials, tokens and emails', () => {
  // Built from pieces so this file never contains the whole example key.
  const awsSecret = ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/');
  const cases: Array<[string, RegExp]> = [
    ['my token is nfp_abcdefghijklmnopqrstuvwx123', /nfp_abc/],
    ['Authorization: Bearer abc.def.ghi-123456', /abc\.def/],
    ['Authorization: Basic dXNlcjpwYXNz', /dXNlcjpwYXNz/],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_part', /eyJhbGci/],
    ['DATABASE_URL=postgres://admin:hunter2@db.example.com/app', /hunter2/],
    ['password: supersecret', /supersecret/],
    ['"apiKey": "k-1234567890"', /k-1234567890/],
    ['contact me at jane.doe@example.com', /jane\.doe/],
    ['aws AKIAABCDEFGHIJKLMNOP here', /AKIAABCDEFGHIJKLMNOP/],
    [`aws secret ${awsSecret} here`, /wJalrXUtnFEMI/],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', /ghp_/],
    ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz', /sk-ant/],
    ['-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----', /MIIEv/],
    ['blob Ab3dEfGh1jKlMn0pQrStUvWxYz12345678AbCdEfGh end', /Ab3dEfGh1j/],
  ];
  for (const [input, leaked] of cases) {
    const { text, redactions } = scrubFeedbackText(input);
    assert.doesNotMatch(text, leaked, `leaked from: ${input}`);
    assert.match(text, /\[REDACTED_/, `no placeholder for: ${input}`);
    assert.ok(redactions >= 1);
  }
});

test('redacts authorization, cookie, credential and session-id values', () => {
  const cases: Array<[string, string]> = [
    ['Authorization: rawtokenvalue123', 'Authorization: [REDACTED_SECRET]'],
    // Every cookie in the header, not just the first.
    ['Cookie: sid=abc123xyz; theme=dark; csrf=q9w8e7', 'Cookie: [REDACTED_SECRET]'],
    ['credentials=hunter2pass', 'credentials=[REDACTED_SECRET]'],
    ['session_id=abcd1234', 'session_id=[REDACTED_SECRET]'],
    ['X-Session-Id: abcd1234', 'X-Session-Id: [REDACTED_SECRET]'],
    // The whole quoted passphrase, not just its first word.
    ['password: "correct horse battery staple"', 'password: "[REDACTED_SECRET]"'],
    ["password='two words'", "password='[REDACTED_SECRET]'"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(scrubFeedbackText(input).text, expected, `for: ${input}`);
  }
});

test('an Authorization header with a scheme keeps the scheme and is redacted once', () => {
  const { text, redactions } = scrubFeedbackText('Authorization: Bearer abc.def.ghi-123456');
  assert.equal(text, 'Authorization: Bearer [REDACTED_TOKEN]');
  assert.equal(redactions, 1);
});

test('leaves ordinary words, paths and Netlify ids alone', () => {
  for (const input of [
    'Deploy 6ae1df8e83162e3a06c77979 for site 331fffbf-1e05-48f4-aed3-3c65470433ab failed at commit 19ed461f99946999fb68720a2251afb312cd6451. See https://docs.netlify.com/build/functions/overview/ for context.',
    'Token validation failed when the bearer expired; basic authentication was not tried.',
    'The file src/components/UserProfile2/settings/index.tsx was skipped.',
  ]) {
    const { text, redactions } = scrubFeedbackText(input);
    assert.equal(text, input);
    assert.equal(redactions, 0, `unexpected redaction in: ${input}`);
  }
});

// ---- The tool ----

test('stores a scrubbed report and logs it', async (t) => {
  const saved = useMemoryStore(t);
  mockUser(t);
  const logs = captureLogs(t);

  const result = JSON.parse(await submitFeedbackDomainTool.cb({
    ...validInput,
    details: `${validInput.details} My token nfp_abcdefghijklmnopqrstuvwx123 was in the error.`,
  }, { request: testRequest(), isRemoteMCP: true }));

  assert.equal(result.status, 'received');
  assert.equal(result.remainingToday, MAX_FEEDBACK_PER_USER_PER_DAY - 1);
  assert.match(result.note, /redacted/);

  assert.equal(saved.size, 1);
  const [[key, record]] = [...saved.entries()];
  assert.match(key, /^reports\/\d{4}-\d{2}-\d{2}\/user-1\/000$/);
  assert.equal(record.userId, 'user-1');
  assert.equal(record.teamId, 'team-1');
  assert.doesNotMatch(String(record.details), /nfp_abc/);
  // The user's email from the API lookup is never stored.
  assert.doesNotMatch(JSON.stringify(record), /someone@example\.com/);

  const line = logs.find(r => r.message === 'mcp feedback submitted');
  assert.ok(line, 'expected a feedback log line');
  assert.equal(line.feedbackSummary, validInput.summary);
  assert.equal(line.feedbackKey, key);
  assert.doesNotMatch(JSON.stringify(line), /nfp_abc/);
});

test('scrubs the client user agent before storing it', async (t) => {
  const saved = useMemoryStore(t);
  mockUser(t);
  captureLogs(t);
  await submitFeedbackDomainTool.cb(validInput, {
    request: testRequest({ 'user-agent': 'my-agent/1.0 (ops@example.com)' }),
  });
  const [record] = [...saved.values()];
  assert.equal(record.userAgent, 'my-agent/1.0 ([REDACTED_EMAIL])');
});

test('uses the identity in an MCP sign-in token without calling the API', async (t) => {
  const saved = useMemoryStore(t);
  const fetchMock = mockUser(t);
  captureLogs(t);
  const token = await createJWE({ accessToken: 'nfp_test_token', identity: { userId: 'jwe-user', teamId: 'jwe-team' } }, '1h');

  const result = JSON.parse(await submitFeedbackDomainTool.cb(validInput, {
    request: testRequest({ Authorization: `Bearer ${token}` }),
  }));

  assert.equal(result.status, 'received');
  assert.equal(fetchMock.mock.callCount(), 0);
  const [record] = [...saved.values()];
  assert.equal(record.userId, 'jwe-user');
  assert.equal(record.teamId, 'jwe-team');
});

test('rejects feedback when the user cannot be identified', async (t) => {
  const saved = useMemoryStore(t);
  mockUser(t, { email: 'someone@example.com' });
  const logs = captureLogs(t);

  const result = JSON.parse(await submitFeedbackDomainTool.cb(validInput, { request: testRequest() }));

  assert.equal(result.status, 'rejected');
  assert.match(result.reason, /identify/);
  assert.equal(saved.size, 0);
  assert.ok(logs.some(r => r.feedbackRejectReason === 'unidentified-user'));
});

test('caps reports per user per day', async (t) => {
  const saved = useMemoryStore(t);
  mockUser(t);
  captureLogs(t);

  for (let i = 0; i < MAX_FEEDBACK_PER_USER_PER_DAY; i++) {
    const r = JSON.parse(await submitFeedbackDomainTool.cb(validInput, { request: testRequest() }));
    assert.equal(r.status, 'received');
  }
  const over = JSON.parse(await submitFeedbackDomainTool.cb(validInput, { request: testRequest() }));
  assert.equal(over.status, 'rejected');
  assert.match(over.reason, /daily limit/);
  assert.equal(saved.size, MAX_FEEDBACK_PER_USER_PER_DAY);
});

test('the daily cap holds when many calls arrive at once', async () => {
  const { slotStore, saved } = memorySlotStore();
  const results = await Promise.all(
    Array.from({ length: 25 }, (_, i) => claimDailySlot(slotStore, '2026-11-02', 'user-1', 10, { i })),
  );
  assert.equal(results.filter(r => r.saved).length, 10);
  assert.equal(saved.size, 10);
});

test('a storage outage still logs the full report and returns an error', async (t) => {
  setFeedbackStoreForTests({ saveInDailySlot: async () => { throw new Error('blobs unavailable'); } });
  t.after(() => setFeedbackStoreForTests(null));
  mockUser(t);
  const logs = captureLogs(t);

  await assert.rejects(
    submitFeedbackDomainTool.cb(validInput, { request: testRequest() }),
    /could not be saved/,
  );
  const line = logs.find(r => r.message === 'mcp feedback storage failed');
  assert.ok(line, 'expected the report on the failure log line');
  assert.equal(line.feedbackSummary, validInput.summary);
  assert.equal(line.feedbackDetails, validInput.details);
});

test('rejects oversized fields without storing anything', async (t) => {
  const saved = useMemoryStore(t);
  mockUser(t);
  captureLogs(t);
  const oversized: Array<Record<string, string>> = [
    { summary: 'x'.repeat(MAX_SUMMARY_CHARS + 1) },
    { details: 'x'.repeat(MAX_DETAILS_CHARS + 1) },
    { suggestion: 'x'.repeat(MAX_SUGGESTION_CHARS + 1) },
    { relatedTool: 'x'.repeat(MAX_SHORT_FIELD_CHARS + 1) },
    { agentName: 'x'.repeat(MAX_SHORT_FIELD_CHARS + 1) },
    { modelName: 'x'.repeat(MAX_SHORT_FIELD_CHARS + 1) },
  ];
  for (const fields of oversized) {
    const field = Object.keys(fields)[0];
    const result = JSON.parse(await submitFeedbackDomainTool.cb({ ...validInput, ...fields } as any, { request: testRequest() }));
    assert.equal(result.status, 'rejected', `${field} over the limit should be rejected`);
    assert.ok(result.issues.some((issue: string) => issue.startsWith(`${field}:`)), `issue should name ${field}`);
  }
  assert.equal(saved.size, 0);
});

test('a call with no params is rejected as invalid, not thrown', async (t) => {
  useMemoryStore(t);
  const logs = captureLogs(t);
  const result = JSON.parse(await submitFeedbackDomainTool.cb({} as any, { request: testRequest() }));
  assert.equal(result.status, 'rejected');
  assert.ok(result.issues.length > 0);
  assert.equal(logs.some(r => r.level === 'error'), false);
});

test('the feedback domain is write-only, additive and remote-only', () => {
  // No operation may read feedback back out.
  for (const tool of feedbackDomainTools) {
    const a = completeToolAnnotations(tool.toolAnnotations);
    assert.equal(a.readOnlyHint, false, `${tool.operation} must not be a reader`);
    assert.equal(a.destructiveHint, false);
  }
  assert.deepEqual(feedbackDomainTools.map(t => t.operation), ['submit-feedback']);
  assert.equal(submitFeedbackDomainTool.omitFromLocalMCP, true);
  assert.equal(submitFeedbackDomainTool.showDescriptionInGroupedTool, true);
  assert.match(submitFeedbackDomainTool.description!, /Never include secrets/);
});
