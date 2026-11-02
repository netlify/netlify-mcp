import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redactSensitive } from './redact.ts';
import { setFeedbackStoreForTests, type FeedbackStore } from './feedback-store.ts';
import {
  submitFeedbackDomainTool,
  MAX_FEEDBACK_PER_USER_PER_DAY,
  MAX_DETAILS_CHARS,
} from './submit-feedback.ts';
import { feedbackDomainTools } from './index.ts';
import { completeToolAnnotations } from '../tool-utils.ts';

const testRequest = () =>
  new Request('https://netlify-mcp.netlify.app/mcp', {
    headers: { Authorization: 'Bearer nfp_test_token', 'user-agent': 'test-agent/1.0' },
  });

const memoryStore = () => {
  const saved = new Map<string, Record<string, unknown>>();
  const store: FeedbackStore = {
    async countForUserOnDay(day, userId) {
      const prefix = `reports/${day}/${encodeURIComponent(userId)}/`;
      return [...saved.keys()].filter(k => k.startsWith(prefix)).length;
    },
    async save(key, record) {
      saved.set(key, record);
    },
  };
  return { store, saved };
};

const mockUser = (t: any) =>
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ id: 'user-1', account_id: 'team-1', email: 'someone@example.com' }), { status: 200 }),
  );

const validInput = {
  category: 'netlify-mcp' as const,
  summary: 'Deploy tool output is hard to follow',
  details: 'The deploy tool returned a long JSON blob without a clear next step for the agent.',
};

test('redacts credentials, tokens and emails', () => {
  const cases: Array<[string, RegExp]> = [
    ['my token is nfp_abcdefghijklmnopqrstuvwx123', /nfp_abc/],
    ['Authorization: Bearer abc.def.ghi-123456', /abc\.def/],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_part', /eyJhbGci/],
    ['DATABASE_URL=postgres://admin:hunter2@db.example.com/app', /hunter2/],
    ['password: supersecret', /supersecret/],
    ['"apiKey": "k-1234567890"', /k-1234567890/],
    ['contact me at jane.doe@example.com', /jane\.doe/],
    ['aws AKIAABCDEFGHIJKLMNOP here', /AKIAABCDEFGHIJKLMNOP/],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', /ghp_/],
    ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz', /sk-ant/],
    ['-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----', /MIIEv/],
    ['blob Ab3dEfGh1jKlMn0pQrStUvWxYz12345678AbCdEfGh end', /Ab3dEfGh1j/],
  ];
  for (const [input, leaked] of cases) {
    const { text, redactions } = redactSensitive(input);
    assert.doesNotMatch(text, leaked, `leaked from: ${input}`);
    assert.match(text, /\[REDACTED_/, `no placeholder for: ${input}`);
    assert.ok(redactions >= 1);
  }
});

test('redacts authorization, cookie, credential and session-id values', () => {
  const cases: Array<[string, string]> = [
    ['Authorization: rawtokenvalue123', 'Authorization: [REDACTED_SECRET]'],
    ['Cookie: sid=abc123xyz; theme=dark', 'Cookie: [REDACTED_SECRET]; theme=dark'],
    ['credentials=hunter2pass', 'credentials=[REDACTED_SECRET]'],
    ['session_id=abcd1234', 'session_id=[REDACTED_SECRET]'],
    ['X-Session-Id: abcd1234', 'X-Session-Id: [REDACTED_SECRET]'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactSensitive(input).text, expected, `for: ${input}`);
  }
});

test('an Authorization header with a scheme keeps the scheme and is redacted once', () => {
  const { text, redactions } = redactSensitive('Authorization: Bearer abc.def.ghi-123456');
  assert.equal(text, 'Authorization: Bearer [REDACTED_TOKEN]');
  assert.equal(redactions, 1);
});

test('leaves ordinary feedback and Netlify ids alone', () => {
  const input = 'Deploy 6ae1df8e83162e3a06c77979 for site 331fffbf-1e05-48f4-aed3-3c65470433ab failed at commit 19ed461f99946999fb68720a2251afb312cd6451. See https://docs.netlify.com/build/functions/overview/ for context.';
  const { text, redactions } = redactSensitive(input);
  assert.equal(text, input);
  assert.equal(redactions, 0);
});

test('stores a redacted report and logs it', async (t) => {
  const { store, saved } = memoryStore();
  setFeedbackStoreForTests(store);
  t.after(() => setFeedbackStoreForTests(null));
  mockUser(t);
  const logged: string[] = [];
  t.mock.method(console, 'log', (line: string) => { logged.push(line); });

  const result = JSON.parse(await submitFeedbackDomainTool.cb({
    ...validInput,
    details: `${validInput.details} My token nfp_abcdefghijklmnopqrstuvwx123 was in the error.`,
  }, { request: testRequest(), isRemoteMCP: true }));

  assert.equal(result.status, 'received');
  assert.equal(result.remainingToday, MAX_FEEDBACK_PER_USER_PER_DAY - 1);
  assert.match(result.note, /redacted/);

  assert.equal(saved.size, 1);
  const [[key, record]] = [...saved.entries()];
  assert.match(key, /^reports\/\d{4}-\d{2}-\d{2}\/user-1\/\d+-/);
  assert.equal(record.userId, 'user-1');
  assert.equal(record.teamId, 'team-1');
  assert.doesNotMatch(String(record.details), /nfp_abc/);
  // The user's email from the API lookup is never stored.
  assert.doesNotMatch(JSON.stringify(record), /someone@example\.com/);

  const line = logged.map(l => JSON.parse(l)).find(r => r.message === 'mcp feedback submitted');
  assert.ok(line, 'expected a feedback log line');
  assert.equal(line.feedbackSummary, validInput.summary);
  assert.doesNotMatch(JSON.stringify(line), /nfp_abc/);
});

test('caps reports per user per day', async (t) => {
  const { store, saved } = memoryStore();
  setFeedbackStoreForTests(store);
  t.after(() => setFeedbackStoreForTests(null));
  mockUser(t);
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});

  for (let i = 0; i < MAX_FEEDBACK_PER_USER_PER_DAY; i++) {
    const r = JSON.parse(await submitFeedbackDomainTool.cb(validInput, { request: testRequest() }));
    assert.equal(r.status, 'received');
  }
  const over = JSON.parse(await submitFeedbackDomainTool.cb(validInput, { request: testRequest() }));
  assert.equal(over.status, 'rejected');
  assert.match(over.reason, /daily limit/);
  assert.equal(saved.size, MAX_FEEDBACK_PER_USER_PER_DAY);
});

test('rejects oversized reports', async (t) => {
  setFeedbackStoreForTests(memoryStore().store);
  t.after(() => setFeedbackStoreForTests(null));
  mockUser(t);
  await assert.rejects(
    submitFeedbackDomainTool.cb({ ...validInput, details: 'x'.repeat(MAX_DETAILS_CHARS + 1) }, { request: testRequest() }),
  );
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
  assert.match(submitFeedbackDomainTool.description!, /Never include secrets/);
});
