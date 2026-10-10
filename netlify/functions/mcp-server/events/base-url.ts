// The public origin to build relay callback URLs from.
//
// This has to be the externally reachable origin, because Netlify itself is the
// caller: it POSTs deliveries to the relay URL we store on the hook, and
// `UrlHook#valid_url?` runs that URL through `PrivateAddressCheck`. A localhost
// or private-address origin is rejected at hook-creation time — so
// `events/subscribe` cannot work against a purely local server. Point
// OAUTH_ISSUER at a deployed origin (or a tunnel) to exercise it.

import { getOAuthIssuer } from '../utils.ts';

/** Origin with no trailing slash, e.g. `https://mcp.netlify.com`. */
export function getServerBaseUrl(req?: Request): string {
  const issuer = getOAuthIssuer();
  try {
    return new URL(issuer).origin;
  } catch {
    // Fall back to the request's own origin if OAUTH_ISSUER is unusable.
    if (req) {
      try {
        return new URL(req.url).origin;
      } catch { /* fall through */ }
    }
    return issuer.replace(/\/+$/, '');
  }
}
