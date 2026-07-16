// Resolve the authenticated user's identity from a raw Netlify access token.
//
// Done ONCE at token-issue time (server-redirect), so the resulting userId and
// team (account) id can be embedded in the JWEs we mint and ride along on every
// later request with no extra lookup. Best-effort: any failure returns null and
// token issuance proceeds without identity — authentication must never break
// because this telemetry lookup failed or was slow.

const NETLIFY_API = 'https://api.netlify.com';
const LOOKUP_TIMEOUT_MS = 3000;

export interface TokenIdentity {
  userId?: string;
  teamId?: string;
}

async function fetchJSON(path: string, token: string): Promise<any | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(`${NETLIFY_API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'user-agent': 'netlify-mcp' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Look up the user and their account (team) id for `token`. Returns null if
 * nothing could be resolved. Both come from the single /api/v1/user response
 * (UserSerializer): `id` is the user id and `account_id` is the user's account —
 * no separate /accounts lookup needed.
 */
export async function resolveIdentity(token: string): Promise<TokenIdentity | null> {
  const user = await fetchJSON('/api/v1/user', token);
  if (!user) {
    return null;
  }

  const identity: TokenIdentity = {};
  if (user.id != null) {
    identity.userId = String(user.id);
  }
  if (user.account_id != null) {
    identity.teamId = String(user.account_id);
  }

  return identity.userId || identity.teamId ? identity : null;
}
