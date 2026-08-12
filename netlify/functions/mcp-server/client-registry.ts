import { createJWE, decryptJWE } from "./utils.ts";
import { getClientById } from "./oauth-clients.ts";
import { log } from "./logger.ts";

// Stateless dynamic client registration.
//
// This server runs on serverless functions behind a round-robin load balancer,
// so it holds NO cross-request state — there is nowhere to persist a dynamic
// client registry. Instead of a datastore, we make the `client_id` itself carry
// the registration: on registration we return a `client_id` that is a JWE of the
// client's metadata (redirect_uris, grant types, etc.). On a later authorize or
// token request we decrypt that same `client_id` to recover the metadata and
// validate the request against it — no lookup, no session affinity.
//
// Only this server can mint or read these ids because they are encrypted with
// JWE_SECRET. Rotating JWE_SECRET invalidates every stateless registration at
// once (clients simply re-register), which is the only revocation lever; that
// trade-off is acceptable for public PKCE clients whose redirect_uris are fixed.

// Marks a JWE as a client registration so a mis-presented access/refresh token
// (which decrypts with the same key but has a different shape) is never mistaken
// for a client.
const CLIENT_REGISTRATION_TOKEN_USE = 'client_registration';

export interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  application_type: 'web' | 'native';
  scope?: string;
  client_name?: string;
}

type ClientSource = 'static' | 'stateless' | 'unknown';

export interface ResolvedClient {
  client: RegisteredClient | null;
  source: ClientSource;
}

/**
 * Loopback hosts per RFC 8252 §7.3 (plus `localhost` and `0.0.0.0`, which
 * clients use in practice). Matches the whole `127.0.0.0/8` range, not just
 * `127.0.0.1`.
 */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/** True for the redirect shapes only a desktop/CLI (native) client uses: a
 * custom scheme, or an http(s) loopback address. */
function isNativeRedirect(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  // Custom schemes (e.g. `cursor://`, `com.example:/cb`) are native by definition.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return true;
  }
  return isLoopbackHost(parsed.hostname);
}

/**
 * Classify a client per the 2026-07-28 spec's `application_type`. We lean
 * toward `native`: if ANY redirect URI is a custom scheme or a loopback
 * address, the client is `native`; only a set of purely remote http(s) origins
 * is `web`. This keeps us from ever storing the invalid combination `web` +
 * custom-scheme redirect (a `web` client is spec-required to use only https web
 * URIs), and lets desktop/CLI clients register localhost redirects.
 */
export function inferApplicationType(redirectUris: string[]): 'web' | 'native' {
  return redirectUris.some(isNativeRedirect) ? 'native' : 'web';
}

/**
 * Mint a stateless `client_id` that encodes the given (already-normalized)
 * client metadata. The returned string is a JWE with no expiry — it lives as
 * long as JWE_SECRET does.
 */
export async function createStatelessClientId(client: Omit<RegisteredClient, 'client_id'>): Promise<string> {
  return createJWE({ token_use: CLIENT_REGISTRATION_TOKEN_USE, ...client }, null);
}

/**
 * Resolve a `client_id` to its registered metadata.
 *
 * - `static`: one of the pre-provisioned clients in oauth-clients.ts.
 * - `stateless`: a JWE `client_id` this server minted; decrypts to its metadata.
 * - `unknown`: neither — e.g. a legacy opaque id issued before stateless DCR, or
 *   an id from another issuer. Callers decide how strict to be (see auth-flow).
 *
 * Never throws: a bad/foreign id resolves to `{ client: null, source: 'unknown' }`.
 */
export async function resolveClient(clientId: string | null | undefined): Promise<ResolvedClient> {
  if (!clientId) {
    return { client: null, source: 'unknown' };
  }

  const staticClient = getClientById(clientId);
  if (staticClient) {
    return {
      client: {
        client_id: clientId,
        redirect_uris: staticClient.redirect_uris ?? [],
        grant_types: staticClient.grant_types ?? ['authorization_code'],
        response_types: staticClient.response_types ?? ['code'],
        token_endpoint_auth_method: staticClient.token_endpoint_auth_method ?? 'client_secret_post',
        application_type: inferApplicationType(staticClient.redirect_uris ?? []),
        scope: typeof staticClient.scope === 'string' ? staticClient.scope : undefined,
      },
      source: 'static',
    };
  }

  try {
    const payload = await decryptJWE(clientId) as Record<string, any>;
    if (payload?.token_use === CLIENT_REGISTRATION_TOKEN_USE && Array.isArray(payload.redirect_uris)) {
      return {
        client: {
          client_id: clientId,
          redirect_uris: payload.redirect_uris,
          grant_types: payload.grant_types ?? ['authorization_code'],
          response_types: payload.response_types ?? ['code'],
          token_endpoint_auth_method: payload.token_endpoint_auth_method ?? 'none',
          application_type: payload.application_type ?? inferApplicationType(payload.redirect_uris),
          scope: payload.scope,
          client_name: payload.client_name,
        },
        source: 'stateless',
      };
    }
    // Decrypted with our key but isn't a registration payload (e.g. an access
    // token presented where a client_id was expected) — not a usable client.
    log.debug('resolveClient: decrypted id is not a client registration', { token_use: payload?.token_use });
  } catch {
    // Not a JWE we can read: a legacy opaque client_id or a foreign id.
  }

  return { client: null, source: 'unknown' };
}

/**
 * Normalize a loopback redirect for port-agnostic comparison. Ignores ONLY the
 * port (chosen at request time per RFC 8252 §7.3) — userinfo, path, query, and
 * fragment must still match, so a crafted variant like
 * `http://evil@127.0.0.1/cb?next=//x` does NOT match a registered
 * `http://127.0.0.1:1234/cb`. Returns null for anything that isn't an http(s)
 * loopback URI so non-loopback redirects fall back to exact matching.
 */
function loopbackKey(uri: string): string | null {
  try {
    const p = new URL(uri);
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
    if (!isLoopbackHost(p.hostname)) return null;
    p.port = ''; // ignore only the port; everything else stays significant
    return p.href;
  } catch {
    return null;
  }
}

/**
 * Is `redirectUri` one the client registered? Exact string match (no
 * substring/prefix matching — those are the classic open-redirect footguns),
 * with one relaxation: for loopback redirects the port is chosen at request
 * time per RFC 8252 §7.3, so we match ignoring the port. A CLI client that
 * registered `http://127.0.0.1:1234/cb` and later listens on a different port
 * still validates.
 */
export function isRedirectUriAllowed(client: RegisteredClient, redirectUri: string): boolean {
  if (client.redirect_uris.includes(redirectUri)) {
    return true;
  }
  const requested = loopbackKey(redirectUri);
  if (!requested) {
    return false;
  }
  return client.redirect_uris.some((registered) => loopbackKey(registered) === requested);
}
