import type { HandlerResponse } from "@netlify/functions";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { getOAuthIssuer } from "./utils.ts";
import { maskToken } from "./logging.ts";
import { log, truncateForLog } from "./logger.ts";
import { resolveIdentity, type TokenIdentity } from "./identity.ts";
import {
  classifyUnresolvedClientId,
  createStatelessClientId,
  inferApplicationType,
  isRedirectUriAllowed,
  resolveClient,
  validateRegisteredRedirectUri,
  type RegisteredClient,
} from "./client-registry.ts";
import { attributionParams } from "./agent-attribution.ts";
// Grant types this Authorization Server issues, shared with the discovery
// metadata so registration validation and what we advertise can't drift apart.
import { OAUTH_ROUTES, SCOPE_DESCRIPTIONS, SUPPORTED_GRANT_TYPES, SUPPORTED_SCOPES } from "./oauth-config.ts";
import {
  ACCESS_TOKEN_LIFETIME_SECONDS,
  issueToken,
  newTokenId,
  TokenError,
  verifyToken,
  type AccessClaims,
  type RefreshClaims,
} from "./tokens.ts";
import {
  getOAuthStore,
  OAuthStorageError,
  RECORD_VERSION,
  revokeGrant,
  TRANSACTION_TTL_MS,
  type AuthTransaction,
  type Grant,
  type OAuthStore,
} from "./oauth-store.ts";

/** Host of a redirect_uri for logging, without leaking the full URI. */
function redirectHostForLog(redirectUri: string): string {
  try {
    return truncateForLog(new URL(redirectUri).host) || 'unknown';
  } catch {
    return 'unparseable';
  }
}

/**
 * Redirect_uri validation gate. `error` is an OAuth error response when the
 * request must be rejected, or null when it may proceed. `client` is the
 * client resolved for this client_id (null when unresolved), handed back so a
 * caller that needs it (e.g. for its `client_name`) doesn't have to resolve
 * it again.
 *
 * Fails closed: a redirect_uri the client did not register, or a client_id
 * this server cannot resolve, gets a 400 and is never redirected to (RFC 6749
 * §4.1.2.1 forbids redirecting on an invalid redirect_uri). The 400 lands in
 * the user's browser, not at the client, so a client with an id this server
 * no longer knows (a legacy opaque id, or a stateless id from before a
 * JWE_SECRET rotation) only recovers when it registers again; a client that
 * must keep working with such an id is pinned in oauth-clients.ts.
 */
async function validateClientRedirect(
  clientId: string,
  redirectUri: string,
  op: string,
): Promise<{ error: HandlerResponse | null; client: RegisteredClient | null; source: 'static' | 'stateless' | 'unknown' }> {
  const { client, source } = await resolveClient(clientId);

  if (client && isRedirectUriAllowed(client, redirectUri)) {
    log.debug(`${op}: redirect_uri validated`, { client_id: maskToken(clientId), source });
    return { error: null, client, source };
  }

  // `reason` says WHY the request failed, since `source: unknown` alone
  // conflates several situations that call for different fixes:
  //  - 'redirect_mismatch': the client resolved fine (static or stateless) but
  //    this redirect_uri isn't one it registered — the attack-relevant case.
  //  - 'jwe-like' / 'opaque' / 'empty': the client_id itself couldn't be
  //    resolved at all — see classifyUnresolvedClientId for what each implies.
  const [error, description] = client
    ? ['invalid_request', 'redirect_uri does not match a registered redirect URI for this client']
    : ['invalid_client', 'This server does not know this client_id; the client must register with it again'];
  return {
    error: oauthError(400, error, description, op, {
      source,
      reason: client ? 'redirect_mismatch' : classifyUnresolvedClientId(clientId),
      client_id: maskToken(clientId),
      redirect_host: redirectHostForLog(redirectUri),
    }),
    client,
    source,
  };
}

const NTL_AUTH_CLIENT_ID = process.env.NTL_AUTH_CLIENT_ID || '';
const AUTH_REQUIRED_PARAMS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method'] as const;

/**
 * Resolve the client_id from a token request. Clients may authenticate using
 * either client_secret_post (client_id in the form body) or client_secret_basic
 * (client_id in the `Authorization: Basic` header, per RFC 6749 §2.3.1). Some
 * clients send Basic auth regardless of the advertised
 * token_endpoint_auth_method, so we check both locations.
 */
function getClientIdFromRequest(req: Request, bodyParams: URLSearchParams): string | null {
  const fromBody = bodyParams.get('client_id');
  if (fromBody) {
    return fromBody;
  }

  // Auth scheme is case-insensitive (RFC 7235) and may be separated from the
  // credentials by arbitrary whitespace, so normalize before matching.
  const authHeader = req.headers.get('authorization')?.trim() ?? '';
  const [scheme, ...rest] = authHeader.split(/\s+/);
  if (scheme.toLowerCase() === 'basic' && rest.length > 0) {
    try {
      const decoded = Buffer.from(rest.join(''), 'base64').toString('utf8');
      // Basic credentials are `urlencode(client_id):urlencode(client_secret)`
      const clientId = decoded.split(':')[0];
      return clientId ? decodeURIComponent(clientId) : null;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Build an OAuth error response and log it. `op` identifies which call failed
 * (e.g. 'authorize', 'token', 'token/refresh', 'server-redirect') and `context`
 * carries any extra detail about why, so failures are traceable from the logs.
 */
function oauthError(
  statusCode: number,
  error: string,
  errorDescription: string,
  op?: string,
  context?: Record<string, unknown>,
): HandlerResponse {
  log.error('oauth error', {
    op: op ?? 'unknown',
    statusCode,
    error,
    error_description: errorDescription,
    ...context,
  });
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
    body: JSON.stringify({
      error,
      error_description: errorDescription,
    }),
  };
}

/**
 * The store is the only thing that makes codes single-use and rotation real,
 * so when it cannot answer the request is refused with a 503 that names it
 * (RFC 6749 §5.2 has no code for this; `temporarily_unavailable` is RFC 6749
 * §4.1.2.1's authorization-endpoint vocabulary and the closest fit).
 */
function storageError(op: string, error: unknown): HandlerResponse {
  const message = error instanceof Error ? error.message : String(error);
  return oauthError(503, 'temporarily_unavailable', `The authorization server's grant store is unavailable; try again shortly. (${message})`, op, { reason: 'storage_unavailable' });
}

function isStorageError(error: unknown): error is OAuthStorageError {
  return error instanceof OAuthStorageError;
}

// ---------------------------------------------------------------------------
// Browser session + transaction binding
//
// /auth creates a transaction record (client, redirect, PKCE, requested scope,
// the client's own state) and hands the browser two unguessable values: the
// transaction id, which travels in URLs, and a session secret, which travels
// only in an HttpOnly cookie. Consent and the callback both require the cookie
// to hash to what the transaction recorded, so a link that carries a
// transaction id — the attacker's own, or the victim's leaked one — does
// nothing in a browser that did not start that transaction.
// ---------------------------------------------------------------------------

function isSecureIssuer(): boolean {
  try {
    return new URL(getOAuthIssuer()).protocol === 'https:';
  } catch {
    return true;
  }
}

// `__Host-` pins the cookie to this exact origin and path (no Domain, Secure,
// Path=/), which browsers only honour over https; the dev name is for
// `netlify dev` on plain http.
function sessionCookieName(): string {
  return isSecureIssuer() ? '__Host-netlify_mcp_oauth' : 'netlify_mcp_oauth';
}

function sessionCookie(value: string, maxAgeSeconds: number): string {
  const attributes = [`${sessionCookieName()}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (isSecureIssuer()) attributes.push('Secure');
  return attributes.join('; ');
}

function readSessionSecret(req: Request): string | null {
  const header = req.headers.get('cookie') ?? '';
  const wanted = sessionCookieName();
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === wanted) {
      const value = rest.join('=');
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
  }
  return null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// The anti-CSRF value on the consent form is derived from the cookie, so it
// can only be produced by a page served into the browser that holds it.
function csrfTokenFor(sessionSecret: string, transactionId: string): string {
  return sha256(`consent:${sessionSecret}:${transactionId}`);
}

function isTransactionId(value: string | null): value is string {
  return !!value && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * Load the transaction behind `txnId` and check that this browser owns it.
 * `null` with a response means the request has already been answered.
 */
async function loadOwnedTransaction(
  store: OAuthStore,
  req: Request,
  txnId: string | null,
  op: string,
): Promise<{ txn: AuthTransaction; etag: string; sessionSecret: string } | { error: HandlerResponse }> {
  if (!isTransactionId(txnId)) {
    return { error: oauthError(400, 'invalid_request', 'Missing or malformed authorization transaction', op, { reason: 'transaction_malformed' }) };
  }
  const sessionSecret = readSessionSecret(req);
  if (!sessionSecret) {
    return { error: oauthError(400, 'invalid_request', 'This browser did not start this authorization; start again from the application', op, { reason: 'session_cookie_missing' }) };
  }
  const found = await store.getTransaction(txnId);
  if (!found) {
    return { error: oauthError(400, 'invalid_request', 'Unknown or expired authorization transaction; start again from the application', op, { reason: 'transaction_unknown' }) };
  }
  if (!safeEqual(found.record.sessionHash, sha256(sessionSecret))) {
    return { error: oauthError(400, 'invalid_request', 'This browser did not start this authorization; start again from the application', op, { reason: 'session_mismatch', client_id: maskToken(found.record.client_id) }) };
  }
  if (Date.now() >= found.record.expiresAt) {
    return { error: oauthError(400, 'invalid_request', 'The authorization request expired; start again from the application', op, { reason: 'transaction_expired', client_id: maskToken(found.record.client_id) }) };
  }
  return { txn: found.record, etag: found.etag, sessionSecret };
}

/** Scopes this server actually grants out of what the client asked for. */
function effectiveScopes(requested: string | undefined): string[] {
  return (requested ?? '').split(/\s+/).filter((s) => s && SUPPORTED_SCOPES.includes(s));
}

export async function handleAuthStart(req: Request): Promise<HandlerResponse>{

  const parsedUrl = new URL(req.url);
  const params = parsedUrl.searchParams;

  log.debug('authorize start', { client_id: params.get('client_id'), redirect_uri: params.get('redirect_uri'), scope: params.get('scope') });

  const missingParams = AUTH_REQUIRED_PARAMS.filter(param => !params.get(param));
  if (missingParams.length > 0) {
    return oauthError(400, 'invalid_request', `Missing required parameters: ${missingParams.join(', ')}`, 'authorize', { missingParams, client_id: params.get('client_id') });
  }

  const responseType = params.get('response_type');
  if (responseType !== 'code') {
    return oauthError(400, 'unsupported_response_type', 'Only response_type=code is supported', 'authorize', { responseType, client_id: params.get('client_id') });
  }

  const codeChallengeMethod = params.get('code_challenge_method');
  if (codeChallengeMethod !== 'S256') {
    return oauthError(400, 'invalid_request', 'code_challenge_method must be S256', 'authorize', { codeChallengeMethod, client_id: params.get('client_id') });
  }

  const clientId = params.get('client_id') as string;
  const redirectUri = params.get('redirect_uri') as string;
  const codeChallenge = params.get('code_challenge') as string;

  // Validate the redirect_uri against the client's registration BEFORE it is
  // recorded. This is the primary defense against an open redirect: an
  // unregistered redirect_uri never enters a transaction, so the callback can
  // only ever 302 to a URI the client registered.
  const { error: redirectError, client, source } = await validateClientRedirect(clientId, redirectUri, 'authorize');
  if (redirectError || !client || source === 'unknown') {
    return redirectError ?? oauthError(400, 'invalid_client', 'Unknown client', 'authorize');
  }

  const sessionSecret = randomBytes(32).toString('base64url');
  const now = Date.now();
  const txn: AuthTransaction = {
    v: RECORD_VERSION,
    id: randomBytes(32).toString('base64url'),
    sessionHash: sha256(sessionSecret),
    client_id: clientId,
    client_source: source,
    ...(client.client_name ? { client_name: client.client_name } : {}),
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    ...(params.get('state') ? { state: params.get('state') as string } : {}),
    ...(params.get('scope') ? { scope: params.get('scope') as string } : {}),
    ...(params.get('nonce') ? { nonce: params.get('nonce') as string } : {}),
    ...(params.get('resource') ? { resource: params.get('resource') as string } : {}),
    status: 'pending',
    createdAt: now,
    expiresAt: now + TRANSACTION_TTL_MS,
  };

  try {
    await getOAuthStore().putTransaction(txn);
  } catch (error) {
    if (isStorageError(error)) return storageError('authorize', error);
    throw error;
  }

  log.info('authorize: transaction created', { client_id: maskToken(clientId), client_source: source, redirect_host: redirectHostForLog(redirectUri), scope: truncateForLog(txn.scope) });

  const consentUrl = new URL(OAUTH_ROUTES.consent, parsedUrl.origin);
  consentUrl.searchParams.set('txn', txn.id);
  return {
    statusCode: 302,
    headers: {
      'Location': consentUrl.toString(),
      'Set-Cookie': sessionCookie(sessionSecret, Math.ceil(TRANSACTION_TTL_MS / 1000)),
      'Cache-Control': 'no-store',
    },
    body: '',
  };
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

const MAX_DISPLAYED_NAME = 80;

function displayName(txn: AuthTransaction): string {
  // Strip control, zero-width and bidi-override characters so a registered
  // name cannot hide or reorder what the page shows.
  const raw = (txn.client_name ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/g, '').trim();
  if (!raw) return 'An application';
  return raw.length > MAX_DISPLAYED_NAME ? `${raw.slice(0, MAX_DISPLAYED_NAME)}\u2026` : raw;
}

const CONSENT_SECURITY_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function consentPage(txn: AuthTransaction, csrf: string, origin: string): string {
  const name = escapeHtml(displayName(txn));
  const redirect = new URL(txn.redirect_uri);
  const scopes = effectiveScopes(txn.scope);
  const verified = txn.client_source === 'static';
  const scopeItems = scopes.length > 0
    ? scopes.map((s) => `<li><code>${escapeHtml(s)}</code> — ${escapeHtml(SCOPE_DESCRIPTIONS[s] ?? '')}</li>`).join('')
    : '<li>No specific scopes were requested.</li>';
  const identityNote = verified
    ? `<p class="badge ok">Verified application: this client is pre-registered with Netlify.</p>`
    : `<p class="badge warn">Unverified application: the name above was supplied by the application when it registered itself and has not been checked by Netlify. Decide based on the destination below, not the name.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name} · Netlify MCP</title>
<style>
  body { font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; background: #f4f5f7; color: #0e1e25; }
  main { max-width: 36rem; margin: 3rem auto; background: #fff; border-radius: 12px; padding: 2rem; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 .5rem; }
  .badge { padding: .6rem .8rem; border-radius: 8px; font-size: .95rem; }
  .ok { background: #e6f7ee; color: #0b5d34; }
  .warn { background: #fff4e5; color: #7a3e00; }
  .dest { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; background: #f4f5f7; padding: .6rem .8rem; border-radius: 8px; }
  .dest strong { color: #0b4f8a; }
  ul { padding-left: 1.2rem; }
  .actions { display: flex; gap: .75rem; margin-top: 1.5rem; }
  button { font: inherit; padding: .7rem 1.2rem; border-radius: 8px; border: 1px solid #c3c9d0; background: #fff; cursor: pointer; }
  button.primary { background: #05bdba; border-color: #05bdba; color: #fff; }
  .fine { font-size: .85rem; color: #4d5a62; margin-top: 1.5rem; }
</style>
</head>
<body>
<main>
  <h1>Allow <span data-client-name>${name}</span> to use your Netlify account?</h1>
  ${identityNote}

  <h2>Where the authorization is sent</h2>
  <p>If you allow it, Netlify MCP will send this application a credential for your account at:</p>
  <p class="dest"><strong>${escapeHtml(redirect.host)}</strong>${escapeHtml(redirect.pathname)}${escapeHtml(redirect.search)}</p>
  <p class="fine">Only approve if you recognise this destination as the application you are connecting from.</p>

  <h2>What it will be able to do</h2>
  <p>Netlify MCP acts on your behalf with the <strong>full access of your Netlify login</strong>: projects, deploys, environment variables including secret values, forms, DNS and team settings. The scopes below are what the application asked for; they do not narrow that access.</p>
  <ul>${scopeItems}</ul>

  <form method="post" action="${escapeHtml(new URL(OAUTH_ROUTES.consent, origin).toString())}">
    <input type="hidden" name="txn" value="${escapeHtml(txn.id)}">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <div class="actions">
      <button class="primary" type="submit" name="decision" value="approve">Allow and continue to Netlify login</button>
      <button type="submit" name="decision" value="deny">Deny</button>
    </div>
  </form>
  <p class="fine">After you allow, Netlify asks you to sign in and confirm. This request expires in ten minutes.</p>
</main>
</body>
</html>`;
}

export async function handleConsentPage(req: Request): Promise<HandlerResponse> {
  const url = new URL(req.url);
  let store: OAuthStore;
  try {
    store = getOAuthStore();
  } catch (error) {
    return storageError('consent', error);
  }
  let owned;
  try {
    owned = await loadOwnedTransaction(store, req, url.searchParams.get('txn'), 'consent');
  } catch (error) {
    if (isStorageError(error)) return storageError('consent', error);
    throw error;
  }
  if ('error' in owned) return owned.error;
  const { txn, sessionSecret } = owned;
  if (txn.status !== 'pending') {
    return oauthError(400, 'invalid_request', 'This authorization request has already been answered; start again from the application', 'consent', { reason: 'transaction_not_pending', status: txn.status });
  }
  return {
    statusCode: 200,
    headers: { ...CONSENT_SECURITY_HEADERS },
    body: consentPage(txn, csrfTokenFor(sessionSecret, txn.id), url.origin),
  };
}

/** Send the user back to the client with an OAuth error (redirect already validated at /auth). */
function redirectWithError(txn: AuthTransaction, error: string, description: string): HandlerResponse {
  const target = new URL(txn.redirect_uri);
  target.searchParams.set('error', error);
  target.searchParams.set('error_description', description);
  if (txn.state) target.searchParams.set('state', txn.state);
  target.searchParams.set('iss', getOAuthIssuer());
  return {
    statusCode: 302,
    headers: { 'Location': target.toString(), 'Cache-Control': 'no-store' },
    body: '',
  };
}

export async function handleConsentDecision(req: Request): Promise<HandlerResponse> {
  const form = new URLSearchParams(await req.text());
  let store: OAuthStore;
  try {
    store = getOAuthStore();
  } catch (error) {
    return storageError('consent/decision', error);
  }

  try {
    const owned = await loadOwnedTransaction(store, req, form.get('txn'), 'consent/decision');
    if ('error' in owned) return owned.error;
    const { txn, etag, sessionSecret } = owned;

    const csrf = form.get('csrf') ?? '';
    if (!safeEqual(csrf, csrfTokenFor(sessionSecret, txn.id))) {
      return oauthError(400, 'invalid_request', 'The consent form did not come from this authorization; start again from the application', 'consent/decision', { reason: 'csrf_mismatch', client_id: maskToken(txn.client_id) });
    }
    if (txn.status !== 'pending') {
      return oauthError(400, 'invalid_request', 'This authorization request has already been answered; start again from the application', 'consent/decision', { reason: 'transaction_not_pending', status: txn.status });
    }

    const decision = form.get('decision');
    if (decision !== 'approve') {
      const declined = await store.updateTransaction({ ...txn, status: 'declined' }, etag);
      log.info('consent declined', { client_id: maskToken(txn.client_id), recorded: declined });
      return redirectWithError(txn, 'access_denied', 'The user declined the authorization request');
    }

    const approved = await store.updateTransaction({ ...txn, status: 'approved', approvedAt: Date.now() }, etag);
    if (!approved) {
      return oauthError(409, 'invalid_request', 'This authorization request was answered concurrently; start again from the application', 'consent/decision', { reason: 'transaction_conflict' });
    }

    log.info('consent approved', { client_id: maskToken(txn.client_id), client_source: txn.client_source, redirect_host: redirectHostForLog(txn.redirect_uri) });

    // Now, and only now, the browser goes to Netlify. The upstream state is the
    // transaction id alone: the callback resolves everything else from the
    // record, so nothing the browser carries back is authoritative.
    const origin = new URL(req.url).origin;
    const netlifyRedirectUri = `${origin}${OAUTH_ROUTES.clientRedirect}`;
    const authorize = new URL('https://app.netlify.com/authorize');
    authorize.searchParams.set('client_id', NTL_AUTH_CLIENT_ID);
    authorize.searchParams.set('response_type', 'token');
    authorize.searchParams.set('state', txn.id);
    authorize.searchParams.set('redirect_uri', netlifyRedirectUri);
    authorize.searchParams.set('utm_source', 'mcp');
    authorize.searchParams.set('utm_campaign', 'integrations');
    return {
      statusCode: 302,
      headers: {
        'Location': `${authorize.toString()}${attributionParams(txn.client_name)}`,
        'Cache-Control': 'no-store',
      },
      body: '',
    };
  } catch (error) {
    if (isStorageError(error)) return storageError('consent/decision', error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Netlify callback
// ---------------------------------------------------------------------------

/**
 * Netlify's own OAuth answers with the token in the URL fragment, which only
 * the browser can read. This page moves it to the server in a same-origin POST
 * body, so the upstream token never appears in a request line, a proxy log or
 * a Referer header.
 */
export async function handleClientSideAuthExchange(){
  return {
    statusCode: 200,
    headers: {
      ...CONSENT_SECURITY_HEADERS,
      'Content-Security-Policy': CLIENT_REDIRECT_CSP,
    },
    body: CLIENT_REDIRECT_PAGE,
  };
}

const CLIENT_REDIRECT_SCRIPT = `
    (function () {
      var hash = window.location.hash || '';
      if (hash.charAt(0) === '#') hash = hash.slice(1);
      if (hash.charAt(0) === '?') hash = hash.slice(1);
      var params = new URLSearchParams(hash);
      var token = params.get('access_token') || params.get('token') || '';
      var state = params.get('state') || '';
      history.replaceState(null, '', window.location.pathname);
      var form = document.getElementById('handoff');
      form.elements.token.value = token;
      form.elements.state.value = state;
      form.submit();
    })();
`;

function scriptHash(script: string): string {
  return `sha256-${createHash('sha256').update(script).digest('base64')}`;
}

const CLIENT_REDIRECT_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Finishing sign-in · Netlify MCP</title>
</head>
<body>
  <p>Finishing sign-in…</p>
  <form id="handoff" method="post" action="${OAUTH_ROUTES.serverRedirect}">
    <input type="hidden" name="token" value="">
    <input type="hidden" name="state" value="">
    <noscript><button type="submit">Continue</button></noscript>
  </form>
  <script>${CLIENT_REDIRECT_SCRIPT}</script>
</body>
</html>`;

// The hash is computed from the literal script so the CSP stays exact if the
// script changes.
const CLIENT_REDIRECT_CSP = `default-src 'none'; script-src '${scriptHash(CLIENT_REDIRECT_SCRIPT)}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;

export async function handleServerSideAuthRedirect(req: Request): Promise<HandlerResponse> {
  if (req.method !== 'POST') {
    return oauthError(405, 'invalid_request', 'The callback accepts the Netlify token only in a POST body', 'server-redirect', { reason: 'method_not_allowed', method: req.method });
  }
  const form = new URLSearchParams(await req.text());
  const token = form.get('token');
  const txnId = form.get('state');

  if (!token) {
    return oauthError(400, 'invalid_request', 'Missing required parameter: token', 'server-redirect', { hasState: !!txnId });
  }

  let store: OAuthStore;
  try {
    store = getOAuthStore();
  } catch (error) {
    return storageError('server-redirect', error);
  }

  try {
    const owned = await loadOwnedTransaction(store, req, txnId, 'server-redirect');
    if ('error' in owned) return owned.error;
    const { txn, etag } = owned;

    if (txn.status !== 'approved') {
      return oauthError(400, 'invalid_request', 'This authorization was not approved in this browser; start again from the application', 'server-redirect', { reason: 'transaction_not_approved', status: txn.status, client_id: maskToken(txn.client_id) });
    }

    // Defense in depth: the record was validated at /auth, but the registry is
    // re-consulted so a client whose registration changed underneath an open
    // transaction cannot be redirected to on stale data.
    const { error: redirectError } = await validateClientRedirect(txn.client_id, txn.redirect_uri, 'server-redirect');
    if (redirectError) {
      return redirectError;
    }

    // Completing the transaction is the single-use step for the callback: two
    // browsers posting the same approved transaction mint at most one code.
    const completed = await store.updateTransaction({ ...txn, status: 'completed' }, etag);
    if (!completed) {
      return oauthError(400, 'invalid_request', 'This authorization was already completed; start again from the application', 'server-redirect', { reason: 'transaction_already_completed', client_id: maskToken(txn.client_id) });
    }

    // Resolve the user/team for this token once, here, so it can be embedded in
    // the code (and downstream access/refresh tokens) without a per-request
    // lookup. Best-effort — never blocks issuing the code.
    const identity = await resolveIdentity(token);

    const grant: Grant = {
      v: RECORD_VERSION,
      id: newTokenId(),
      client_id: txn.client_id,
      redirect_uri: txn.redirect_uri,
      ...(txn.scope ? { scope: txn.scope } : {}),
      ...(identity ? { identity } : {}),
      transaction: txn.id,
      createdAt: Date.now(),
      currentRefresh: null,
      revoked: null,
    };
    await store.putGrant(grant);

    log.info('server redirect: issuing authorization code', { client_id: maskToken(txn.client_id), redirect_host: redirectHostForLog(txn.redirect_uri), scope: truncateForLog(txn.scope), hasIdentity: !!identity, grant: grant.id });

    const code = await issueToken<'code'>({
      typ: 'code',
      grant: grant.id,
      client_id: txn.client_id,
      redirect_uri: txn.redirect_uri,
      code_challenge: txn.code_challenge,
      code_challenge_method: 'S256',
      ...(txn.scope ? { scope: txn.scope } : {}),
      accessToken: token,
      ...(identity ? { identity } : {}),
    });

    const target = new URL(txn.redirect_uri);
    if (txn.state) {
      target.searchParams.set('state', txn.state);
    }
    // RFC 9207: Include iss parameter in authorization response
    target.searchParams.set('iss', getOAuthIssuer());
    target.searchParams.set('code', code);

    return {
      statusCode: 302,
      headers: {
        'Location': target.toString(),
        // The session has done its job; drop it so a later page on this origin
        // cannot reuse it.
        'Set-Cookie': sessionCookie('', 0),
        'Cache-Control': 'no-store',
      },
      body: '',
    };
  } catch (error) {
    if (isStorageError(error)) return storageError('server-redirect', error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const MAX_REDIRECT_URIS = 32;

/**
 * RFC 7591 Dynamic Client Registration, stateless.
 *
 * We don't persist the client anywhere: the returned `client_id` IS a JWE of the
 * registered metadata (see client-registry.ts), so a later authorize/token
 * request can recover and validate it with no lookup. This keeps registration
 * working behind a plain round-robin load balancer with no shared store.
 *
 * `supportedScopes` is threaded in from the OAuth server config so requested
 * scopes are sanitized down to what this AS actually grants (an unsupported
 * scope is dropped rather than failing the whole registration).
 */
export async function handleClientRegistration(req: Request, supportedScopes: string[]): Promise<HandlerResponse> {
  let body: Record<string, any>;
  try {
    body = JSON.parse(await req.text());
  } catch (error) {
    return oauthError(400, 'invalid_client_metadata', 'Registration body must be valid JSON', 'register', { detail: error instanceof Error ? error.message : String(error) });
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u: unknown): u is string => typeof u === 'string')
    : [];

  // Intersect requested grant types with what we support; default to
  // authorization_code when the client sends none.
  const requestedGrantTypes: string[] = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code'];
  const grantTypes = requestedGrantTypes.filter((g) => SUPPORTED_GRANT_TYPES.includes(g));
  const effectiveGrantTypes = grantTypes.length > 0 ? grantTypes : ['authorization_code'];

  // redirect_uris are required for the authorization_code flow (the only flow
  // that redirects). RFC 7591 §3.2.2 uses `invalid_redirect_uri` for this.
  if (effectiveGrantTypes.includes('authorization_code') && redirectUris.length === 0) {
    return oauthError(400, 'invalid_redirect_uri', 'At least one redirect_uri is required for the authorization_code grant', 'register');
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    return oauthError(400, 'invalid_redirect_uri', `At most ${MAX_REDIRECT_URIS} redirect_uris may be registered`, 'register', { count: redirectUris.length });
  }
  for (const uri of redirectUris) {
    const problem = validateRegisteredRedirectUri(uri);
    if (problem) {
      return oauthError(400, 'invalid_redirect_uri', `redirect_uri rejected: ${problem}`, 'register', { reason: problem, redirect_host: redirectHostForLog(uri) });
    }
  }

  // Sanitize requested scopes to the supported set (drop the field if nothing
  // remains) so an unsupported scope doesn't fail the whole registration.
  let scope: string | undefined;
  if (typeof body.scope === 'string') {
    const allowed = body.scope.split(/\s+/).filter((s: string) => s && supportedScopes.includes(s));
    scope = allowed.length > 0 ? allowed.join(' ') : undefined;
  }

  // Always infer rather than trust a client-supplied value: a client that
  // mislabels a custom-scheme or loopback redirect as `web` would otherwise be
  // stored as the invalid combination `web` + non-web redirect (a `web` client
  // must use only https web URIs).
  const applicationType = inferApplicationType(redirectUris);

  const client: Omit<RegisteredClient, 'client_id'> = {
    redirect_uris: redirectUris,
    grant_types: effectiveGrantTypes,
    response_types: ['code'],
    // Public PKCE clients: we issue no client_secret and don't persist one.
    token_endpoint_auth_method: 'none',
    application_type: applicationType,
    ...(scope ? { scope } : {}),
    ...(typeof body.client_name === 'string' ? { client_name: body.client_name } : {}),
  };

  const clientId = await createStatelessClientId(client);

  // client_name, redirect_uris, and scope are client-asserted: nothing verifies
  // client_name, and a registration can send arbitrarily many/long redirect_uris.
  // The bounded copies below are for this log line only — the stored client and
  // the response below carry the full, untouched values.
  const MAX_LOGGED_REDIRECT_URIS = 10;

  log.info('register: issued stateless client_id', {
    redirect_hosts: redirectUris.slice(0, MAX_LOGGED_REDIRECT_URIS).map(redirectHostForLog),
    application_type: applicationType,
    scope: truncateForLog(scope),
    client_name: truncateForLog(body.client_name),
  });

  // RFC 7591 §3.2.1 success response. client_id_issued_at is informational; the
  // registration never expires (no client_secret_expires_at needed for a public
  // client), and revocation is via JWE_SECRET rotation.
  const registration: Record<string, any> = {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    grant_types: effectiveGrantTypes,
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: applicationType,
    ...(scope ? { scope } : {}),
    ...(typeof body.client_name === 'string' ? { client_name: body.client_name } : {}),
  };

  return {
    statusCode: 201,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
    body: JSON.stringify(registration),
  };
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

function tokenRejection(error: TokenError, op: string, context: Record<string, unknown>): HandlerResponse {
  const description = error.reason === 'legacy_refresh'
    ? 'This refresh token predates client binding and cannot be rotated; reconnect the application to Netlify MCP'
    : error.reason === 'wrong_purpose'
      ? 'The presented token is not valid for this grant'
      : op === 'token/refresh' ? 'Invalid or expired refresh token' : 'Invalid or expired authorization code';
  return oauthError(400, 'invalid_grant', description, op, { reason: error.reason, presented: error.presented, ...context });
}

async function mintTokens(store: OAuthStore, grant: Grant, etag: string, source: { accessToken: string; identity?: TokenIdentity; scope?: string; client_id: string }, op: string): Promise<HandlerResponse> {
  const scopes = effectiveScopes(source.scope);
  const offline = scopes.includes('offline_access');
  const refreshJti = offline ? newTokenId() : null;

  // The grant records which refresh token is current before the new one goes
  // out, so a presentation of the old one is reuse the moment this returns.
  const rotated = await store.updateGrant({ ...grant, currentRefresh: refreshJti }, etag);
  if (!rotated) {
    // Something else moved the grant between our read and this write — a
    // concurrent redemption or rotation. Whichever it was, this request lost
    // and the token it presented is no longer the current one.
    await revokeGrant(store, grant.id, `concurrent ${op}`);
    return oauthError(400, 'invalid_grant', 'The grant changed while this request was being processed; reconnect the application', op, { reason: 'grant_conflict', grant: grant.id, client_id: maskToken(source.client_id) });
  }

  const common = {
    grant: grant.id,
    client_id: source.client_id,
    ...(source.scope ? { scope: source.scope } : {}),
    accessToken: source.accessToken,
    ...(source.identity ? { identity: source.identity } : {}),
  };
  const accessToken = await issueToken<'access'>({ typ: 'access', ...common });
  const tokenResponse: Record<string, unknown> = {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
    ...(source.scope ? { scope: scopes.join(' ') } : {}),
  };
  if (refreshJti) {
    tokenResponse.refresh_token = await issueToken<'refresh'>({ typ: 'refresh', jti: refreshJti, ...common });
  }
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
    },
    body: JSON.stringify(tokenResponse),
  };
}

export async function handleCodeExchange(req: Request): Promise<HandlerResponse> {

  const body = await req.text();

  // get data from application/x-www-form-urlencoded body
  const bodyParams = new URLSearchParams(body);
  const grantType = bodyParams.get('grant_type') || 'authorization_code';

  log.debug('token exchange', { grantType, client_id: bodyParams.get('client_id'), hasAuthHeader: !!req.headers.get('authorization') });

  if (grantType === 'refresh_token') {
    return handleRefreshTokenGrant(req, bodyParams);
  }
  if (grantType !== 'authorization_code') {
    return oauthError(400, 'unsupported_grant_type', `Unsupported grant_type: ${grantType}`, 'token', { grantType });
  }

  // client_id may arrive in the body (client_secret_post) or the Authorization
  // header (client_secret_basic).
  const clientId = getClientIdFromRequest(req, bodyParams);
  const requiredParams: Record<string, string | null> = {
    code: bodyParams.get('code'),
    client_id: clientId,
    redirect_uri: bodyParams.get('redirect_uri'),
    code_verifier: bodyParams.get('code_verifier'),
  };
  const missingParams = Object.entries(requiredParams)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if(missingParams.length > 0) {
    return oauthError(400, 'invalid_request', `Missing required parameters: ${missingParams.join(', ')}`, 'token', {
      grantType,
      missingParams,
      clientIdSource: bodyParams.get('client_id') ? 'body' : (req.headers.get('authorization') ? 'authorization-header' : 'absent'),
    });
  }

  const code = requiredParams.code as string;
  const redirectUri = requiredParams.redirect_uri as string;
  const codeVerifier = requiredParams.code_verifier as string;
  const logContext = { client_id: maskToken(clientId as string) };

  let claims;
  try {
    claims = await verifyToken(code, 'code');
  } catch (error) {
    if (error instanceof TokenError) return tokenRejection(error, 'token', logContext);
    throw error;
  }

  if (claims.client_id !== clientId || claims.redirect_uri !== redirectUri) {
    return oauthError(400, 'invalid_grant', 'client_id or redirect_uri does not match authorization code', 'token', {
      ...logContext,
      clientIdMatches: claims.client_id === clientId,
      redirectUriMatches: claims.redirect_uri === redirectUri,
    });
  }

  if(!isPKCEValid(codeVerifier, claims.code_challenge, claims.code_challenge_method)) {
    return oauthError(400, 'invalid_grant', 'PKCE verification failed', 'token', logContext);
  }

  let store: OAuthStore;
  try {
    store = getOAuthStore();
  } catch (error) {
    return storageError('token', error);
  }

  try {
    // RFC 6749 §4.1.2: a code presented twice is an attack signal, and every
    // token already issued on it is revoked along with the grant.
    const first = await store.redeemCode(claims.jti);
    if (!first) {
      await revokeGrant(store, claims.grant, 'authorization code replayed');
      return oauthError(400, 'invalid_grant', 'Authorization code has already been used; the grant has been revoked', 'token', { ...logContext, reason: 'code_replayed', grant: claims.grant });
    }

    const found = await store.getGrant(claims.grant);
    if (!found || found.record.revoked || found.record.client_id !== claims.client_id) {
      return oauthError(400, 'invalid_grant', 'The grant behind this authorization code is no longer valid', 'token', { ...logContext, reason: !found ? 'grant_missing' : found.record.revoked ? 'grant_revoked' : 'grant_client_mismatch', grant: claims.grant });
    }

    const response = await mintTokens(store, found.record, found.etag, {
      accessToken: claims.accessToken,
      identity: claims.identity,
      scope: claims.scope,
      client_id: claims.client_id,
    }, 'token');

    if (response.statusCode === 200) {
      // The confident "user authenticated" point: the full OAuth handshake has
      // completed here (PKCE validated, session token minted) after Netlify
      // authenticated the human at server-redirect. Fires once per interactive
      // login; a silent refresh (handleRefreshTokenGrant) is deliberately NOT this.
      log.info('user authenticated', {
        userId: claims.identity?.userId,
        teamId: claims.identity?.teamId,
        client_id: clientId,
        hasOfflineAccess: effectiveScopes(claims.scope).includes('offline_access'),
        grant: claims.grant,
      });
    }
    return response;
  } catch (error) {
    if (isStorageError(error)) return storageError('token', error);
    throw error;
  }
}

async function handleRefreshTokenGrant(req: Request, bodyParams: URLSearchParams): Promise<HandlerResponse> {
  const refreshToken = bodyParams.get('refresh_token');
  const clientId = getClientIdFromRequest(req, bodyParams);

  if (!refreshToken || !clientId) {
    return oauthError(400, 'invalid_request', `Missing required parameter: ${!refreshToken ? 'refresh_token' : 'client_id'}`, 'token/refresh', {
      clientIdSource: bodyParams.get('client_id') ? 'body' : (req.headers.get('authorization') ? 'authorization-header' : 'absent'),
    });
  }
  const logContext = { client_id: maskToken(clientId) };

  let claims: RefreshClaims;
  try {
    claims = await verifyToken(refreshToken, 'refresh');
  } catch (error) {
    if (error instanceof TokenError) return tokenRejection(error, 'token/refresh', logContext);
    throw error;
  }

  // A refresh token is usable only by the client it was issued to. The
  // binding is the sealed claim, never the submitted client_id on its own.
  if (claims.client_id !== clientId) {
    return oauthError(400, 'invalid_grant', 'refresh_token was not issued to this client', 'token/refresh', { ...logContext, reason: 'client_mismatch' });
  }

  let store: OAuthStore;
  try {
    store = getOAuthStore();
  } catch (error) {
    return storageError('token/refresh', error);
  }

  try {
    const found = await store.getGrant(claims.grant);
    if (!found || found.record.revoked) {
      return oauthError(400, 'invalid_grant', 'The grant behind this refresh token has been revoked; reconnect the application', 'token/refresh', { ...logContext, reason: found ? 'grant_revoked' : 'grant_missing', grant: claims.grant });
    }
    if (found.record.currentRefresh !== claims.jti) {
      // RFC 6749 §10.4 / OAuth 2.1 §6.1: a rotated-out refresh token being
      // presented means it leaked (or the legitimate client lost the race to a
      // thief); the whole family stops working.
      await revokeGrant(store, claims.grant, 'refresh token reused after rotation');
      return oauthError(400, 'invalid_grant', 'This refresh token was already rotated; the grant has been revoked and the application must reconnect', 'token/refresh', { ...logContext, reason: 'refresh_reused', grant: claims.grant });
    }

    const response = await mintTokens(store, found.record, found.etag, {
      accessToken: claims.accessToken,
      identity: claims.identity,
      scope: claims.scope,
      client_id: claims.client_id,
    }, 'token/refresh');
    if (response.statusCode === 200) {
      log.info('refresh token grant: issued new tokens', { userId: claims.identity?.userId, teamId: claims.identity?.teamId, grant: claims.grant });
    }
    return response;
  } catch (error) {
    if (isStorageError(error)) return storageError('token/refresh', error);
    throw error;
  }
}

/**
 * RFC 7009 token revocation. Revoking either token of a grant revokes the
 * grant: every access and refresh token minted on it stops working at the
 * next /mcp request or refresh. Always answers 200 for a token this server
 * does not recognise, as the RFC requires, so the endpoint reveals nothing.
 */
export async function handleRevocation(req: Request): Promise<HandlerResponse> {
  const bodyParams = new URLSearchParams(await req.text());
  const token = bodyParams.get('token');
  const clientId = getClientIdFromRequest(req, bodyParams);
  const ok: HandlerResponse = { statusCode: 200, headers: { 'Cache-Control': 'no-store' }, body: '' };
  if (!token) {
    return oauthError(400, 'invalid_request', 'Missing required parameter: token', 'revoke');
  }

  let claims: AccessClaims | RefreshClaims | null = null;
  for (const type of ['refresh', 'access'] as const) {
    try {
      claims = await verifyToken(token, type);
      break;
    } catch {
      // try the other type
    }
  }
  if (!claims || !claims.grant) {
    log.info('revoke: token not recognised or carries no grant', { client_id: maskToken(clientId) });
    return ok;
  }
  if (clientId && claims.client_id !== clientId) {
    return oauthError(400, 'invalid_grant', 'The token was not issued to this client', 'revoke', { client_id: maskToken(clientId), reason: 'client_mismatch' });
  }

  try {
    await revokeGrant(getOAuthStore(), claims.grant, `revoked by client via ${OAUTH_ROUTES.revocation}`);
  } catch (error) {
    if (isStorageError(error)) return storageError('revoke', error);
    throw error;
  }
  return ok;
}

function isPKCEValid(codeVerifier: string, codeChallenge: string, codeChallengeMethod = 'S256') {
  if (codeChallengeMethod === 'S256') {
    // SHA-256 hash the code_verifier, base64url encode, and compare
    const hash = createHash('sha256').update(codeVerifier).digest();
    const base64url = hash
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return base64url === codeChallenge;
  }
  // Only S256 is accepted at /auth, so anything else here is a forged code.
  return false;
}
