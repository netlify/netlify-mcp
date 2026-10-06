// Shared driver for the OAuth flow in tests: registration, /auth, the consent
// page, approval, the Netlify callback handoff and the token endpoint, with
// the browser's cookie carried the way a browser would.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import {
  handleAuthStart,
  handleClientRegistration,
  handleCodeExchange,
  handleConsentDecision,
  handleConsentPage,
  handleRevocation,
  handleServerSideAuthRedirect,
} from './auth-flow.ts';
import { SUPPORTED_SCOPES } from './oauth-config.ts';

export const ISSUER = 'http://localhost:8888';

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export async function register(redirectUris: string[], clientName = 'Redirect binding test'): Promise<string> {
  const res = await handleClientRegistration(
    new Request(`${ISSUER}/oauth-server/reg`, {
      method: 'POST',
      body: JSON.stringify({ redirect_uris: redirectUris, client_name: clientName }),
    }),
    SUPPORTED_SCOPES,
  );
  assert.equal(res.statusCode, 201, res.body as string);
  return JSON.parse(res.body as string).client_id;
}

export function authorize(clientId: string, redirectUri: string, challenge: string, scope?: string, extra: Record<string, string> = {}) {
  const url = new URL(`${ISSUER}/oauth-server/auth`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', 'client-state');
  if (scope) url.searchParams.set('scope', scope);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return handleAuthStart(new Request(url));
}

export function location(res: { headers?: Record<string, unknown> }): URL {
  const value = res.headers?.Location;
  assert.equal(typeof value, 'string', 'expected a Location header');
  return new URL(value as string);
}

/** The session cookie as the browser would send it back. */
export function cookieFrom(res: { headers?: Record<string, unknown> }): string {
  const setCookie = res.headers?.['Set-Cookie'];
  assert.equal(typeof setCookie, 'string', 'expected a Set-Cookie header');
  return (setCookie as string).split(';')[0];
}

export async function consentPage(txn: string, cookie: string | null) {
  const url = new URL(`${ISSUER}/oauth-server/consent`);
  url.searchParams.set('txn', txn);
  return handleConsentPage(new Request(url, { headers: cookie ? { cookie } : {} }));
}

export function csrfFrom(html: string): string {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  assert.ok(match, 'consent page carries a csrf token');
  return match[1];
}

export async function decide(form: Record<string, string>, cookie: string | null) {
  return handleConsentDecision(new Request(`${ISSUER}/oauth-server/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(form).toString(),
  }));
}

export async function callback(form: Record<string, string>, cookie: string | null, method = 'POST') {
  return handleServerSideAuthRedirect(new Request(`${ISSUER}/oauth-server/server-redirect`, {
    method,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: method === 'POST' ? new URLSearchParams(form).toString() : undefined,
  }));
}

export function exchange(form: Record<string, string>, headers: Record<string, string> = {}) {
  return handleCodeExchange(
    new Request(`${ISSUER}/oauth-server/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(form).toString(),
    }),
  );
}

export function revoke(form: Record<string, string>) {
  return handleRevocation(
    new Request(`${ISSUER}/oauth-server/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    }),
  );
}

export interface StartedFlow {
  txn: string;
  cookie: string;
  consentHtml: string;
  csrf: string;
}

/** /auth then GET consent, as the browser does. */
export async function startFlow(clientId: string, redirectUri: string, challenge: string, scope?: string): Promise<StartedFlow> {
  const start = await authorize(clientId, redirectUri, challenge, scope);
  assert.equal(start.statusCode, 302, start.body as string);
  const consentUrl = location(start);
  assert.equal(consentUrl.pathname, '/oauth-server/consent');
  const txn = consentUrl.searchParams.get('txn');
  assert.ok(txn);
  const cookie = cookieFrom(start);
  const page = await consentPage(txn, cookie);
  assert.equal(page.statusCode, 200, page.body as string);
  const consentHtml = page.body as string;
  return { txn, cookie, consentHtml, csrf: csrfFrom(consentHtml) };
}

/** Approve consent and return the Netlify authorize URL the browser is sent to. */
export async function approve(flow: StartedFlow): Promise<URL> {
  const res = await decide({ txn: flow.txn, csrf: flow.csrf, decision: 'approve' }, flow.cookie);
  assert.equal(res.statusCode, 302, res.body as string);
  const netlify = location(res);
  assert.equal(netlify.origin, 'https://app.netlify.com');
  return netlify;
}

/** Netlify's callback handoff: the token and the state, posted with the cookie. */
export async function finish(flow: StartedFlow, netlify: URL, token = 'netlify-token-from-browser') {
  return callback({ token, state: netlify.searchParams.get('state') as string }, flow.cookie);
}

export interface CompletedFlow extends StartedFlow {
  code: string;
  clientCallback: URL;
}

/** The whole browser side: a code delivered to the client's redirect. */
export async function completeFlow(clientId: string, redirectUri: string, challenge: string, scope?: string): Promise<CompletedFlow> {
  const flow = await startFlow(clientId, redirectUri, challenge, scope);
  const netlify = await approve(flow);
  const redirect = await finish(flow, netlify);
  assert.equal(redirect.statusCode, 302, redirect.body as string);
  const clientCallback = location(redirect);
  const code = clientCallback.searchParams.get('code');
  assert.ok(code);
  return { ...flow, code, clientCallback };
}

export async function obtainTokens(clientId: string, redirectUri: string, scope = 'offline_access read') {
  const { verifier, challenge } = pkcePair();
  const flow = await completeFlow(clientId, redirectUri, challenge, scope);
  const res = await exchange({ grant_type: 'authorization_code', code: flow.code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier });
  assert.equal(res.statusCode, 200, res.body as string);
  const body = JSON.parse(res.body as string) as { access_token: string; refresh_token?: string };
  return { ...body, flow, verifier };
}
