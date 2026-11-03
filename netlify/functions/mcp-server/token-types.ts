// Every JWE this server issues under JWE_SECRET (authorization codes, access
// tokens, refresh tokens, /proxy tokens) is encrypted with the same key, so on
// its own a successful decrypt says nothing about WHAT the token is. Without a
// type, an unexchanged authorization code or a refresh token works as a bearer
// at /mcp, and an access token works at /proxy without the proxy's allowlist.
//
// New tokens carry a `typ` claim and each endpoint accepts only the types meant
// for it. Tokens minted before `typ` existed have no claim at all; those are
// let through unchecked so the rollout logs nobody out. That legacy path closes
// on its own: the longest-lived token (refresh, 7 days) is reissued with a
// `typ` on every refresh, so once a week has passed since deploy every token
// still valid carries one and the `typ === undefined` branch can be removed.

export const TOKEN_TYPE = {
  code: 'code',
  access: 'access',
  refresh: 'refresh',
  proxy: 'proxy',
} as const;

export type TokenType = typeof TOKEN_TYPE[keyof typeof TOKEN_TYPE];

/**
 * Whether a decrypted token may be used where only `allowed` types are
 * accepted. A token with no `typ` predates typing and is allowed (see above).
 */
export function isTokenTypeAllowed(payload: Record<string, unknown> | undefined, allowed: readonly TokenType[]): boolean {
  const typ = payload?.typ;
  if (typ === undefined) {
    return true;
  }
  return typeof typ === 'string' && (allowed as readonly string[]).includes(typ);
}
