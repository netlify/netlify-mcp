import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import {
  MemoryOAuthStore,
  OAuthStorageError,
  setOAuthStore,
  type AuthTransaction,
  type Grant,
  type OAuthStore,
} from './oauth-store.ts';
import { verifyToken } from './tokens.ts';
import { handleCodeExchange } from './auth-flow.ts';
import {
  approve,
  callback,
  consentPage,
  csrfFrom,
  decide,
  exchange,
  finish,
  ISSUER,
  location,
  pkcePair,
  register,
  startFlow,
} from './oauth-test-flow.ts';

process.env.OAUTH_ISSUER = ISSUER;
process.env.OAUTH_STORE = 'memory';
delete process.env.JWE_SECRET;

const REDIRECT = 'https://client-a.example.com/callback';
const HTML = { accept: 'text/html,application/xhtml+xml' };

type Op = 'putTransaction' | 'getTransaction' | 'updateTransaction' | 'putGrant' | 'getGrant' | 'updateGrant' | 'redeemCode' | 'isCodeRedeemed';

/** Fails chosen calls once, the way a store that times out mid-request does, and counts grants. */
class FlakyStore implements OAuthStore {
  readonly inner = new MemoryOAuthStore();
  readonly grantsCreated: string[] = [];
  private plan: { op: Op; skip: number; after?: boolean } | null = null;

  /** Fail the `skip`+1th call of `op`; with `after`, only once the write has landed. */
  failOnce(op: Op, skip = 0, after = false) {
    this.plan = { op, skip, after };
  }

  private async run<T>(op: Op, work: () => Promise<T>): Promise<T> {
    const plan = this.plan;
    if (plan && plan.op === op) {
      if (plan.skip > 0) {
        plan.skip -= 1;
      } else {
        this.plan = null;
        if (plan.after) {
          await work();
        }
        throw new OAuthStorageError(`injected ${op} failure`);
      }
    }
    return work();
  }

  putTransaction(t: AuthTransaction) { return this.run('putTransaction', () => this.inner.putTransaction(t)); }
  getTransaction(id: string) { return this.run('getTransaction', () => this.inner.getTransaction(id)); }
  updateTransaction(t: AuthTransaction, e: string) { return this.run('updateTransaction', () => this.inner.updateTransaction(t, e)); }
  putGrant(g: Grant) {
    return this.run('putGrant', async () => {
      const created = await this.inner.putGrant(g);
      if (created) this.grantsCreated.push(g.id);
      return created;
    });
  }
  getGrant(id: string) { return this.run('getGrant', () => this.inner.getGrant(id)); }
  updateGrant(g: Grant, e: string) { return this.run('updateGrant', () => this.inner.updateGrant(g, e)); }
  redeemCode(j: string) { return this.run('redeemCode', () => this.inner.redeemCode(j)); }
  isCodeRedeemed(j: string) { return this.run('isCodeRedeemed', () => this.inner.isCodeRedeemed(j)); }
}

let store: FlakyStore;
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
const origFetch = globalThis.fetch;
before(() => {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  // The identity lookup at the callback is the only upstream call here.
  globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'user-1', account_id: 'team-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
});
after(() => {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;
  globalThis.fetch = origFetch;
});
beforeEach(() => {
  store = new FlakyStore();
  setOAuthStore(store);
});

async function approvedFlow() {
  const clientId = await register([REDIRECT]);
  const { verifier, challenge } = pkcePair();
  const flow = await startFlow(clientId, REDIRECT, challenge, 'offline_access read');
  const netlify = await approve(flow);
  return { clientId, verifier, flow, netlify };
}

function htmlCallback(form: Record<string, string>, cookie: string | null, method = 'POST') {
  const { handleServerSideAuthRedirect } = imports;
  return handleServerSideAuthRedirect(new Request(`${ISSUER}/oauth-server/server-redirect`, {
    method,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...HTML, ...(cookie ? { cookie } : {}) },
    body: method === 'POST' ? new URLSearchParams(form).toString() : undefined,
  }));
}

function htmlConsent(txn: string, cookie: string | null) {
  const { handleConsentPage } = imports;
  return handleConsentPage(new Request(`${ISSUER}/oauth-server/consent?txn=${txn}`, { headers: { ...HTML, ...(cookie ? { cookie } : {}) } }));
}

const imports = await import('./auth-flow.ts');

function stateOf(res: { body?: string }): string | undefined {
  return (res.body ?? '').match(/data-state="([a-z_]+)"/)?.[1];
}

// ---------------------------------------------------------------------------
// Recovery from a failure part-way through issuing the code
// ---------------------------------------------------------------------------

// Each storage call the callback makes, in order. A failure at any of them is
// answered 503, and the same browser retrying gets one grant and one code.
const CALLBACK_FAILURES: Array<{ label: string; op: Op; skip: number; after?: boolean }> = [
  { label: 'reading the transaction', op: 'getTransaction', skip: 0 },
  { label: 'recording that issuance began (write lost)', op: 'updateTransaction', skip: 0 },
  { label: 'recording that issuance began (write landed, answer lost)', op: 'updateTransaction', skip: 0, after: true },
  { label: 're-reading the transaction', op: 'getTransaction', skip: 1 },
  { label: 'looking up the grant', op: 'getGrant', skip: 0 },
  { label: 'creating the grant (write lost)', op: 'putGrant', skip: 0 },
  { label: 'creating the grant (write landed, answer lost)', op: 'putGrant', skip: 0, after: true },
  { label: 'marking the transaction completed (write lost)', op: 'updateTransaction', skip: 1 },
  { label: 'marking the transaction completed (write landed, answer lost)', op: 'updateTransaction', skip: 1, after: true },
];

for (const failure of CALLBACK_FAILURES) {
  test(`callback: a store failure while ${failure.label} is recoverable by retrying, with one grant and one code`, async () => {
    const { clientId, verifier, flow, netlify } = await approvedFlow();

    store.failOnce(failure.op, failure.skip, failure.after);
    const failed = await finish(flow, netlify);
    assert.equal(failed.statusCode, 503, `the failure surfaces: ${failed.body}`);
    assert.equal(failed.headers?.Location, undefined, 'nothing is delivered on a failure');

    const retried = await finish(flow, netlify);
    assert.equal(retried.statusCode, 302, retried.body as string);
    const code = location(retried).searchParams.get('code') as string;
    const claims = await verifyToken(code, 'code');

    assert.equal(store.grantsCreated.length, 1, 'exactly one grant exists for the transaction');
    assert.equal(claims.grant, store.grantsCreated[0]);

    const txn = await store.inner.getTransaction(flow.txn);
    assert.equal(txn?.record.status, 'completed');
    assert.equal(txn?.record.issuance?.code, claims.jti, 'the delivered code is the one the transaction promised');

    const ok = await exchange({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    assert.equal(ok.statusCode, 200, ok.body as string);
    // A real replay of the code is still an attack signal.
    const replay = await exchange({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    assert.equal(replay.statusCode, 400);
    assert.match(JSON.parse(replay.body as string).error_description, /revoked/);
  });
}

test('consent: a store failure while recording approval is recoverable by submitting again', async () => {
  const clientId = await register([REDIRECT]);
  const flow = await startFlow(clientId, REDIRECT, pkcePair().challenge);

  store.failOnce('updateTransaction', 0, true);
  const failed = await decide({ txn: flow.txn, csrf: flow.csrf, decision: 'approve' }, flow.cookie);
  assert.equal(failed.statusCode, 503);

  const again = await decide({ txn: flow.txn, csrf: flow.csrf, decision: 'approve' }, flow.cookie);
  assert.equal(again.statusCode, 302);
  assert.equal(location(again).origin, 'https://app.netlify.com');
});

test('two callbacks racing on one approved transaction produce one grant and the same code', async () => {
  const { flow, netlify } = await approvedFlow();
  const [a, b] = await Promise.all([finish(flow, netlify), finish(flow, netlify)]);
  assert.equal(a.statusCode, 302, a.body as string);
  assert.equal(b.statusCode, 302, b.body as string);
  const [ca, cb] = await Promise.all([a, b].map((r) => verifyToken(location(r).searchParams.get('code') as string, 'code')));
  assert.equal(ca.jti, cb.jti);
  assert.equal(store.grantsCreated.length, 1);
});

test('a retry must carry the same Netlify sign-in: a different upstream token gets nothing', async () => {
  const { flow, netlify } = await approvedFlow();
  store.failOnce('updateTransaction', 1);
  assert.equal((await finish(flow, netlify, 'netlify-token-a')).statusCode, 503);
  const swapped = await finish(flow, netlify, 'netlify-token-b');
  assert.equal(swapped.statusCode, 400);
  assert.equal(swapped.headers?.Location, undefined);
  const original = await finish(flow, netlify, 'netlify-token-a');
  assert.equal(original.statusCode, 302);
});

test('a code redeemed before its revocation is never re-delivered', async () => {
  const { clientId, verifier, flow, netlify } = await approvedFlow();
  const first = await finish(flow, netlify);
  const code = location(first).searchParams.get('code') as string;
  await exchange({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
  const reload = await htmlCallback({ token: 'netlify-token-from-browser', state: flow.txn }, flow.cookie);
  assert.equal(reload.statusCode, 400);
  assert.equal(stateOf(reload), 'finished');
  assert.equal(reload.headers?.Location, undefined);
});

// ---------------------------------------------------------------------------
// Resume, cancel and upstream cancellation
// ---------------------------------------------------------------------------

test('Back from the Netlify login shows a resume page that can continue or cancel', async () => {
  const { flow } = await approvedFlow();
  const page = await consentPage(flow.txn, flow.cookie);
  assert.equal(page.statusCode, 200);
  assert.match(page.body as string, /You already allowed/);
  assert.match(page.body as string, /Continue to Netlify login/);
  assert.match(page.body as string, /Cancel sign-in/);

  const resumed = await decide({ txn: flow.txn, csrf: csrfFrom(page.body as string), decision: 'approve' }, flow.cookie);
  assert.equal(resumed.statusCode, 302);
  assert.equal(location(resumed).origin, 'https://app.netlify.com');
});

test('cancelling an approved, unfinished sign-in tells the client and ends the transaction', async () => {
  const { flow, netlify } = await approvedFlow();
  const cancelled = await decide({ txn: flow.txn, csrf: flow.csrf, decision: 'deny' }, flow.cookie);
  assert.equal(cancelled.statusCode, 302);
  const target = location(cancelled);
  assert.equal(`${target.origin}${target.pathname}`, REDIRECT);
  assert.equal(target.searchParams.get('error'), 'access_denied');
  assert.equal(target.searchParams.get('state'), 'client-state');

  // A Netlify callback arriving afterwards mints nothing.
  const late = await finish(flow, netlify);
  assert.equal(late.statusCode, 400);
  assert.equal(late.headers?.Location, undefined);
  assert.equal(store.grantsCreated.length, 0);
  assert.equal(stateOf(await htmlConsent(flow.txn, flow.cookie)), 'cancelled');
});

test('a finished sign-in cannot be cancelled', async () => {
  const { flow, netlify } = await approvedFlow();
  assert.equal((await finish(flow, netlify)).statusCode, 302);
  const res = await decide({ txn: flow.txn, csrf: flow.csrf, decision: 'deny' }, flow.cookie);
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers?.Location, undefined);
});

test('a cancelled Netlify login is passed to the client as access_denied', async () => {
  const { flow } = await approvedFlow();
  const res = await callback({ token: '', state: flow.txn, error: 'access_denied' }, flow.cookie);
  assert.equal(res.statusCode, 302);
  const target = location(res);
  assert.equal(`${target.origin}${target.pathname}`, REDIRECT);
  assert.equal(target.searchParams.get('error'), 'access_denied');
  assert.equal((await store.inner.getTransaction(flow.txn))?.record.status, 'declined');
  // And a token posted after that is refused.
  assert.equal((await callback({ token: 'tok', state: flow.txn }, flow.cookie)).statusCode, 400);
});

test('an upstream error from another browser is refused without touching the transaction', async () => {
  const { flow } = await approvedFlow();
  const res = await callback({ token: '', state: flow.txn, error: 'access_denied' }, `${flow.cookie.split('=')[0]}=${'Z'.repeat(43)}`);
  assert.equal(res.statusCode, 400);
  assert.equal((await store.inner.getTransaction(flow.txn))?.record.status, 'approved');
});

/** Run the handoff page's script against a stand-in browser and return what it would post. */
async function handoff(hash: string, search = '') {
  const page = await imports.handleClientSideAuthExchange();
  const html = page.body as string;
  const start = html.indexOf('<script>');
  const script = start === -1 ? undefined : html.slice(start + '<script>'.length, html.indexOf('</script>', start));
  assert.ok(script, 'the handoff page carries its script');
  const fields: Record<string, { value: string }> = { token: { value: '' }, state: { value: '' }, error: { value: '' } };
  let submitted = false;
  const context = {
    URLSearchParams,
    window: { location: { hash, search, pathname: '/oauth-server/client-redirect' } },
    history: { replaceState() {} },
    document: { getElementById: () => ({ elements: fields, submit() { submitted = true; } }) },
  };
  runInNewContext(script, context);
  return { submitted, token: fields.token.value, state: fields.state.value, error: fields.error.value };
}

test('the handoff page posts the token, or Netlify\'s error, from the fragment', async () => {
  assert.deepEqual(await handoff('#access_token=tok&state=txn1'), { submitted: true, token: 'tok', state: 'txn1', error: '' });
  assert.deepEqual(await handoff('#error=access_denied&state=txn1'), { submitted: true, token: '', state: 'txn1', error: 'access_denied' });
});

test('the handoff page ignores a query string, so a link cannot cancel someone\'s sign-in', async () => {
  assert.deepEqual(await handoff('', '?error=access_denied&state=txn1'), { submitted: true, token: '', state: '', error: '' });
});

// ---------------------------------------------------------------------------
// Pages for people, JSON for programs
// ---------------------------------------------------------------------------

test('browser endpoints answer a person with a page that says what happened', async () => {
  const { flow, netlify } = await approvedFlow();

  const noCookie = await htmlConsent(flow.txn, null);
  assert.equal(noCookie.statusCode, 400);
  assert.match(String(noCookie.headers?.['Content-Type']), /text\/html/);
  assert.equal(stateOf(noCookie), 'other_browser');

  const otherBrowser = await htmlConsent(flow.txn, `${flow.cookie.split('=')[0]}=${'Q'.repeat(43)}`);
  assert.equal(stateOf(otherBrowser), 'other_browser');

  const malformed = await htmlConsent('not-a-transaction', flow.cookie);
  assert.equal(stateOf(malformed), 'unknown');

  const getCallback = await htmlCallback({}, flow.cookie, 'GET');
  assert.equal(getCallback.statusCode, 405);
  assert.equal(stateOf(getCallback), 'method');

  const noToken = await htmlCallback({ state: flow.txn }, flow.cookie);
  assert.equal(stateOf(noToken), 'no_token');

  // Finished, then reloaded after the cookie was dropped.
  assert.equal((await finish(flow, netlify)).statusCode, 302);
  const reload = await htmlConsent(flow.txn, null);
  assert.equal(stateOf(reload), 'finished');

  // Every page keeps the framing and caching protections.
  for (const res of [noCookie, getCallback, reload]) {
    assert.equal(res.headers?.['X-Frame-Options'], 'DENY');
    assert.equal(res.headers?.['Cache-Control'], 'no-store');
    assert.doesNotMatch(res.body as string, /^\s*\{/);
  }
});

test('an expired request says so and how to start again', async () => {
  const { flow } = await approvedFlow();
  const found = await store.inner.getTransaction(flow.txn);
  await store.inner.updateTransaction({ ...(found!.record), expiresAt: Date.now() - 1 }, found!.etag);
  const res = await htmlConsent(flow.txn, flow.cookie);
  assert.equal(res.statusCode, 400);
  assert.equal(stateOf(res), 'expired');
  assert.match(res.body as string, /start the connection again/);
});

test('a store outage is a 503 page with Retry-After for a person and JSON for a program', async () => {
  const { flow } = await approvedFlow();
  store.failOnce('getTransaction');
  const page = await htmlConsent(flow.txn, flow.cookie);
  assert.equal(page.statusCode, 503);
  assert.equal(page.headers?.['Retry-After'], '5');
  assert.equal(stateOf(page), 'unavailable');

  store.failOnce('getTransaction');
  const json = await consentPage(flow.txn, flow.cookie);
  assert.equal(json.statusCode, 503);
  assert.equal(JSON.parse(json.body as string).error, 'temporarily_unavailable');
});

test('machine endpoints keep answering JSON even when asked for HTML', async () => {
  const res = await handleCodeExchange(new Request(`${ISSUER}/oauth-server/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...HTML },
    body: new URLSearchParams({ grant_type: 'authorization_code' }).toString(),
  }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body as string).error, 'invalid_request');
});

// ---------------------------------------------------------------------------
// Consent copy and accessibility
// ---------------------------------------------------------------------------

test('consent shows the expiry of the actual transaction, not a fixed number', async () => {
  const clientId = await register([REDIRECT]);
  const flow = await startFlow(clientId, REDIRECT, pkcePair().challenge);
  const record = (await store.inner.getTransaction(flow.txn))!.record;
  const lifetime = Math.round((record.expiresAt - record.createdAt) / 60_000);
  assert.match(flow.consentHtml, new RegExp(`expires in ${lifetime} minutes`));
  assert.doesNotMatch(flow.consentHtml, /ten minutes/);
  assert.match(flow.consentHtml, new RegExp(`datetime="${new Date(record.expiresAt).toISOString()}"`));

  const realNow = Date.now;
  Date.now = () => record.expiresAt - 4.5 * 60_000;
  try {
    const later = await consentPage(flow.txn, flow.cookie);
    assert.match(later.body as string, /expires in 5 minutes/);
  } finally {
    Date.now = realNow;
  }
});

test('consent buttons meet WCAG AA contrast, show focus and fit a narrow screen', async () => {
  const clientId = await register([REDIRECT]);
  const { consentHtml } = await startFlow(clientId, REDIRECT, pkcePair().challenge);
  const primary = consentHtml.match(/button\.primary \{ background: (#[0-9a-f]{6});[^}]*[^-]color: (#[0-9a-f]{3,6})/);
  assert.ok(primary);
  assert.ok(contrast(primary[1], primary[2]) >= 4.5, `Allow button contrast ${contrast(primary[1], primary[2]).toFixed(2)}:1`);
  const border = consentHtml.match(/button \{[^}]*border: 1px solid (#[0-9a-f]{6})/);
  assert.ok(border);
  assert.ok(contrast(border[1], '#ffffff') >= 3, 'the Deny button boundary is visible');
  assert.match(consentHtml, /button:focus-visible \{ outline: 3px solid/);
  assert.match(consentHtml, /@media \(max-width: 30rem\)/);
  assert.match(consentHtml, /<meta name="viewport"/);
  // The full-account disclosure and the meaning of "unverified" stay.
  assert.match(consentHtml, /full access of your Netlify login/);
  assert.match(consentHtml, /registered itself with Netlify MCP automatically/);
  assert.match(consentHtml, /Netlify has not checked who runs it/);
});

function contrast(a: string, b: string): number {
  const lum = (raw: string) => {
    const hex = raw.length === 4 ? `#${[...raw.slice(1)].map((c) => c + c).join('')}` : raw;
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// Interrupted sign-ins and the token exchange
// ---------------------------------------------------------------------------

test('an interrupted sign-in with no grant yet can be finished by signing in to Netlify again', async () => {
  const { flow, netlify } = await approvedFlow();
  // Fails right after issuance was recorded, before any grant exists.
  store.failOnce('getTransaction', 1);
  assert.equal((await finish(flow, netlify, 'netlify-token-a')).statusCode, 503);

  const page = await htmlConsent(flow.txn, flow.cookie);
  assert.equal(page.statusCode, 200);
  assert.match(page.body as string, /Continue to Netlify login/);
  const again = await decide({ txn: flow.txn, csrf: csrfFrom(page.body as string), decision: 'approve' }, flow.cookie);
  assert.equal(location(again).origin, 'https://app.netlify.com');

  const done = await finish(flow, netlify, 'netlify-token-b');
  assert.equal(done.statusCode, 302, done.body as string);
  assert.equal(store.grantsCreated.length, 1);
});

test('an interrupted sign-in whose grant exists says so instead of claiming it finished', async () => {
  const { flow, netlify } = await approvedFlow();
  store.failOnce('updateTransaction', 1);
  assert.equal((await finish(flow, netlify, 'netlify-token-a')).statusCode, 503);
  const other = await htmlCallback({ token: 'netlify-token-b', state: flow.txn }, flow.cookie);
  assert.equal(other.statusCode, 400);
  assert.equal(stateOf(other), 'interrupted');
});

test('cancelling an interrupted sign-in revokes the grant it had created', async () => {
  const { flow, netlify } = await approvedFlow();
  store.failOnce('updateTransaction', 1);
  assert.equal((await finish(flow, netlify)).statusCode, 503);
  const grantId = store.grantsCreated[0];
  const res = await decide({ txn: flow.txn, csrf: flow.csrf, decision: 'deny' }, flow.cookie);
  assert.equal(res.statusCode, 302);
  assert.equal(location(res).searchParams.get('error'), 'access_denied');
  assert.ok((await store.inner.getGrant(grantId))?.record.revoked);
  const late = await finish(flow, netlify);
  assert.equal(late.statusCode, 400);
  assert.equal(late.headers?.Location, undefined);
});

for (const failure of [
  { label: 'reading the grant after the redemption was recorded', op: 'getGrant' as Op, skip: 0 },
  { label: 'recording the issued tokens on the grant (write lost)', op: 'updateGrant' as Op, skip: 0 },
]) {
  test(`token exchange: a store failure while ${failure.label} is retried, not treated as a replay`, async () => {
    const { clientId, verifier, flow, netlify } = await approvedFlow();
    const code = location(await finish(flow, netlify)).searchParams.get('code') as string;
    const form = { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier };

    store.failOnce(failure.op, failure.skip);
    assert.equal((await exchange(form)).statusCode, 503);
    const retried = await exchange(form);
    assert.equal(retried.statusCode, 200, retried.body as string);

    const replay = await exchange(form);
    assert.equal(replay.statusCode, 400);
    assert.match(JSON.parse(replay.body as string).error_description, /revoked/);
  });
}

test('an unknown transaction opened without a cookie says it cannot be found', async () => {
  const res = await htmlConsent('A'.repeat(43), null);
  assert.equal(stateOf(res), 'unknown');
});

test('one lagging read of the grant does not get a freshly rotated refresh token family revoked', async () => {
  const { clientId, verifier, flow, netlify } = await approvedFlow();
  const code = location(await finish(flow, netlify)).searchParams.get('code') as string;
  const first = JSON.parse((await exchange({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier })).body as string);
  const grantId = (await verifyToken(first.access_token, 'access')).grant as string;
  const before = await store.inner.getGrant(grantId);
  const rotated = JSON.parse((await exchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId })).body as string);

  const realGetGrant = store.getGrant.bind(store);
  let lagOnce = true;
  store.getGrant = async (id: string) => {
    if (lagOnce && id === grantId) { lagOnce = false; return structuredClone(before); }
    return realGetGrant(id);
  };
  const res = await exchange({ grant_type: 'refresh_token', refresh_token: rotated.refresh_token, client_id: clientId });
  assert.equal(res.statusCode, 200, res.body as string);
  assert.equal((await store.inner.getGrant(grantId))?.record.revoked, null);
});
