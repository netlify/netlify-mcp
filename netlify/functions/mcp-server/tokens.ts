import { createJWE, decryptJWE, getOAuthIssuer } from "./utils.ts";
import type { TokenIdentity } from "./identity.ts";

// Every credential this server mints is a JWE under JWE_SECRET, so without a
// purpose claim any of them decrypts anywhere the key is known: an unexchanged
// authorization code was a working bearer token at /mcp and /proxy. Each token
// now carries `typ`, the issuer and the audience of the one endpoint that may
// consume it, and every consumer goes through verifyToken() with the type it
// expects before it looks at anything else in the payload.

export type TokenType = 'code' | 'access' | 'refresh' | 'proxy';

export const TOKEN_LIFETIMES: Record<TokenType, string> = {
  // RFC 6749 §4.1.2 recommends a maximum of ten minutes; the exchange follows
  // the redirect immediately, so five is generous.
  code: '5m',
  access: '48h',
  refresh: '7d',
  proxy: '30m',
};
export const ACCESS_TOKEN_LIFETIME_SECONDS = 48 * 60 * 60;

/**
 * Legacy access tokens — the pre-`typ` `{ accessToken, identity? }` shape — are
 * accepted at /mcp only, and only until this instant. They live 48 hours, so
 * every one issued before the typed tokens deployed has expired on its own
 * well before then; the date is the hard stop in case the deploy slips.
 * Nothing else legacy is accepted: a legacy refresh token has no client or
 * grant binding and is answered with a reconnect, and a legacy proxy token is
 * refused outright (a fresh one is one tool call away).
 */
export const LEGACY_ACCESS_TOKEN_SUNSET = Date.UTC(2026, 9, 13); // 2026-10-13T00:00:00Z

export interface ApiAllowance {
  path: string;
  method: string;
}

interface BaseClaims {
  typ: TokenType;
  jti: string;
  /** The grant this token belongs to; null for a proxy token minted from a PAT. */
  grant: string | null;
  client_id: string | null;
  scope?: string;
  /** The upstream Netlify token the resource server acts with. */
  accessToken: string;
  identity?: TokenIdentity;
}

export interface CodeClaims extends BaseClaims {
  typ: 'code';
  grant: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: 'S256';
}

export interface AccessClaims extends BaseClaims {
  typ: 'access';
  /** True only for a pre-`typ` token accepted through the legacy window. */
  legacy?: boolean;
}

export interface RefreshClaims extends BaseClaims {
  typ: 'refresh';
  grant: string;
  client_id: string;
}

export interface ProxyClaims extends BaseClaims {
  typ: 'proxy';
  siteId?: string;
  apisAllowed: ApiAllowance[];
}

export type ClaimsFor<T extends TokenType> =
  T extends 'code' ? CodeClaims :
  T extends 'access' ? AccessClaims :
  T extends 'refresh' ? RefreshClaims :
  ProxyClaims;

export type TokenClaims = CodeClaims | AccessClaims | RefreshClaims | ProxyClaims;

export type TokenRejection =
  | 'undecryptable'   // not ours, expired, or sealed under another key
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'wrong_purpose'   // a valid token of another type presented here
  | 'malformed'       // right type, but a required claim is missing or mistyped
  | 'legacy_refresh'  // pre-binding refresh token: the client must reconnect
  | 'legacy_expired'; // pre-`typ` access token after the sunset

export class TokenError extends Error {
  readonly reason: TokenRejection;
  readonly presented?: string;
  constructor(reason: TokenRejection, presented?: string) {
    super(`token rejected: ${reason}`);
    this.name = 'TokenError';
    this.reason = reason;
    this.presented = presented;
  }
}

/** The endpoint allowed to consume each type, as an absolute URL under the issuer. */
export function audienceFor(type: TokenType): string {
  const path = type === 'access' ? '/mcp' : type === 'proxy' ? '/proxy' : '/oauth-server/token';
  return new URL(path, getOAuthIssuer()).toString();
}

export function newTokenId(): string {
  return crypto.randomUUID();
}

type IssueInput<T extends TokenType> = Omit<ClaimsFor<T>, 'jti'> & { jti?: string };

export async function issueToken<T extends TokenType>(claims: IssueInput<T>): Promise<string> {
  const payload = { ...claims, jti: claims.jti ?? newTokenId() };
  return createJWE(payload, TOKEN_LIFETIMES[claims.typ], undefined, {
    issuer: getOAuthIssuer(),
    audience: audienceFor(claims.typ),
  });
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isAllowanceList(value: unknown): value is ApiAllowance[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => entry && typeof entry === 'object' && isString(entry.path) && isString(entry.method));
}

const LEGACY_ACCESS_KEYS = new Set(['accessToken', 'identity', 'iat', 'exp']);

/**
 * A pre-`typ` access token is exactly `{ accessToken, identity? }` plus the
 * registration claims jose adds. Anything with another key — a legacy refresh
 * token's `type`, a legacy proxy token's `apisAllowed`, a legacy code's
 * `state`, a registration's `token_use` — is not one and is never accepted.
 */
function asLegacyAccess(payload: Record<string, unknown>): AccessClaims | null {
  if (!isString(payload.accessToken)) return null;
  if (!Object.keys(payload).every((key) => LEGACY_ACCESS_KEYS.has(key))) return null;
  const identity = payload.identity;
  return {
    typ: 'access',
    jti: '',
    grant: null,
    client_id: null,
    accessToken: payload.accessToken,
    legacy: true,
    ...(identity && typeof identity === 'object' ? { identity: identity as TokenIdentity } : {}),
  };
}

function checkShape(payload: Record<string, unknown>, type: TokenType): TokenClaims {
  const common = isString(payload.jti) && isString(payload.accessToken)
    && (payload.grant === null || isString(payload.grant))
    && (payload.client_id === null || isString(payload.client_id))
    && (payload.scope === undefined || typeof payload.scope === 'string');
  if (!common) throw new TokenError('malformed');

  switch (type) {
    case 'code':
      if (!isString(payload.grant) || !isString(payload.client_id) || !isString(payload.redirect_uri)
        || !isString(payload.code_challenge) || payload.code_challenge_method !== 'S256') {
        throw new TokenError('malformed');
      }
      break;
    case 'refresh':
      if (!isString(payload.grant) || !isString(payload.client_id)) throw new TokenError('malformed');
      break;
    case 'proxy':
      if (!isAllowanceList(payload.apisAllowed)) throw new TokenError('malformed');
      break;
    case 'access':
      break;
  }
  return payload as unknown as TokenClaims;
}

/**
 * Decrypt `jwe` and accept it only as a `type` token for this issuer and this
 * type's audience. Expiry is validated by decryptJWE. Throws TokenError with
 * the reason; callers map that to their own error shape and never fall back.
 */
export async function verifyToken<T extends TokenType>(jwe: string, type: T): Promise<ClaimsFor<T>> {
  let payload: Record<string, unknown>;
  try {
    payload = await decryptJWE(jwe) as Record<string, unknown>;
  } catch {
    throw new TokenError('undecryptable');
  }

  if (payload.typ === undefined) {
    if (type === 'access') {
      const legacy = asLegacyAccess(payload);
      if (legacy) {
        if (Date.now() >= LEGACY_ACCESS_TOKEN_SUNSET) throw new TokenError('legacy_expired');
        return legacy as ClaimsFor<T>;
      }
    }
    if (type === 'refresh' && payload.type === 'refresh' && isString(payload.accessToken)) {
      throw new TokenError('legacy_refresh');
    }
    throw new TokenError('wrong_purpose', typeof payload.type === 'string' ? payload.type : typeof payload.token_use === 'string' ? payload.token_use : 'untyped');
  }

  if (payload.typ !== type) {
    throw new TokenError('wrong_purpose', typeof payload.typ === 'string' ? payload.typ : 'unknown');
  }
  if (payload.iss !== getOAuthIssuer()) throw new TokenError('wrong_issuer');
  if (payload.aud !== audienceFor(type)) throw new TokenError('wrong_audience');

  return checkShape(payload, type) as ClaimsFor<T>;
}
