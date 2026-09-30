// Thin client over Netlify's outgoing-hooks API, plus site resolution.
//
// These endpoints are the whole persistence layer for MCP event subscriptions:
// `GET /hooks` is the subscription lookup, `POST`/`PUT` create and refresh, and
// `DELETE` unsubscribes. There is no local store.

import { authenticatedFetch, getAPIJSONResult, getTokenIdentity, NetlifyApiError } from '../../../../src/utils/api-networking.ts';
import { log } from '../logger.ts';

/**
 * A hook create/update failure that keeps the API's own response body. Netlify's
 * 422s carry a written explanation (e.g. its uniqueness validation on
 * site+event+url) that we cannot reconstruct, and it is worth relaying.
 */
export class HookApiError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(`Netlify hook API failed: ${status}`);
    this.name = 'HookApiError';
    this.status = status;
    this.detail = detail;
  }
}

export interface NetlifyHook {
  id: string;
  site_id: string;
  type: string;
  event: string;
  data?: { url?: string; signature_secret?: string };
  disabled?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface NetlifyHookTypeInfo {
  name: string;
  events: string[];
  restricted_events?: string[];
  fields?: unknown[];
}

/**
 * The Netlify user id of the caller, used as part of the subscription identity.
 *
 * `getTokenIdentity()` is only a fast path: it reads the id embedded in a JWE
 * bearer at token-issue time, and is documented to return null for a raw
 * personal access token (nfp/nfu/nfo) — it exists for log attribution, not as
 * an authoritative source. It can also come back null for a JWE, because the
 * identity lookup that populates it is best-effort and may have timed out when
 * the token was minted.
 *
 * So `/api/v1/user` is the authority. The two agree by construction — the JWE's
 * `identity.userId` is `String(user.id)` from this same endpoint (see
 * identity.ts) — which matters because the id feeds the deterministic
 * subscription id: if it differed by token type, the same user's subscribe and
 * unsubscribe would not resolve to the same hook.
 */
export async function resolveSubscriberUserId(incomingRequest: Request): Promise<string | null> {
  const embedded = await getTokenIdentity(incomingRequest);
  if (embedded?.userId) {
    return embedded.userId;
  }

  const user = await getAPIJSONResult<{ id?: string | number } | string>(
    '/api/v1/user',
    {},
    {},
    incomingRequest,
  );
  if (user && typeof user === 'object' && user.id !== undefined && user.id !== null) {
    return String(user.id);
  }
  return null;
}

interface SiteSummary {
  id: string;
  name?: string;
}

/**
 * Resolve whatever the caller passed as `site` to a site id.
 *
 * Accepts an id or a name/slug, because a user asking to watch "my marketing
 * site" is the whole point of the feature — requiring the model to look the id
 * up first is an extra round trip it will sometimes get wrong.
 */
export async function resolveSite(
  site: string,
  incomingRequest: Request,
): Promise<SiteSummary | null> {
  // 404 and 403 both mean "not a site you can use", and collapsing them avoids
  // turning this into an existence oracle for sites the caller can't see.
  // Everything else (500, 502, ...) must NOT be swallowed: reporting "no site
  // found" when the API is simply down sends the caller off fixing the wrong
  // thing.
  const notFound = [404, 403];
  const quietly = {
    quietStatuses: notFound,
    failureCallback: (response: Response) => {
      if (!notFound.includes(response.status)) {
        throw new NetlifyApiError(response.status);
      }
      return '';
    },
  };

  // Try as an id first. Netlify site ids are UUIDs, but sites are also
  // addressable by name on this endpoint, so a single GET covers both when the
  // caller gave us something unambiguous.
  const direct = await getAPIJSONResult<SiteSummary | string>(
    `/api/v1/sites/${encodeURIComponent(site)}`,
    {},
    quietly,
    incomingRequest,
  );
  if (direct && typeof direct === 'object' && direct.id) {
    return direct;
  }

  // Fall back to a name search.
  const matches = await getAPIJSONResult<SiteSummary[] | string>(
    `/api/v1/sites?name=${encodeURIComponent(site)}`,
    {},
    quietly,
    incomingRequest,
  );
  if (Array.isArray(matches) && matches.length > 0) {
    // Prefer an exact name match; a substring search can return several.
    const exact = matches.find((s) => s.name === site);
    return exact ?? matches[0];
  }

  return null;
}

/**
 * The hook types (and per-event entitlement) available for a site.
 *
 * `site_id` is documented on the controller but missing from the published
 * `swagger.json`, so `@netlify/open-api` types do not describe this shape.
 */
export async function getSiteHookTypes(
  siteId: string,
  incomingRequest: Request,
): Promise<NetlifyHookTypeInfo[]> {
  const result = await getAPIJSONResult<NetlifyHookTypeInfo[] | string>(
    `/api/v1/hooks/types?site_id=${encodeURIComponent(siteId)}`,
    {},
    {},
    incomingRequest,
  );
  return Array.isArray(result) ? result : [];
}

export async function listSiteHooks(
  siteId: string,
  netlifyEvent: string,
  incomingRequest: Request,
): Promise<NetlifyHook[]> {
  const result = await getAPIJSONResult<NetlifyHook[] | string>(
    `/api/v1/hooks?site_id=${encodeURIComponent(siteId)}&event=${encodeURIComponent(netlifyEvent)}`,
    {},
    {},
    incomingRequest,
  );
  return Array.isArray(result) ? result : [];
}

/**
 * Find an existing hook for this subscription. Matches on the `subId` segment of
 * the relay URL rather than the whole URL, because the URL's JWE segment changes
 * whenever the client rotates its signing secret on refresh — so a whole-URL
 * comparison (which is what Netlify's own uniqueness validation does) would
 * treat a refresh as a brand-new subscription and leave the old hook behind.
 */
export function findHookBySubscriptionId(hooks: NetlifyHook[], subId: string): NetlifyHook | undefined {
  return hooks.find((hook) => hook.data?.url?.includes(`/events/relay/${subId}/`));
}

export async function createSiteHook(args: {
  siteId: string;
  netlifyEvent: string;
  relayUrl: string;
  signatureSecret: string;
  incomingRequest: Request;
}): Promise<NetlifyHook> {
  const response = await authenticatedFetch(
    `/api/v1/hooks?site_id=${encodeURIComponent(args.siteId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'url',
        event: args.netlifyEvent,
        data: { url: args.relayUrl, signature_secret: args.signatureSecret },
      }),
    },
    args.incomingRequest,
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    log.warn('events hook create failed', { status: response.status, detail: detail.slice(0, 300) });
    throw new HookApiError(response.status, detail);
  }
  return await response.json() as NetlifyHook;
}

export async function updateSiteHook(args: {
  hookId: string;
  netlifyEvent: string;
  relayUrl: string;
  signatureSecret: string;
  incomingRequest: Request;
}): Promise<NetlifyHook> {
  const response = await authenticatedFetch(
    `/api/v1/hooks/${encodeURIComponent(args.hookId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: args.netlifyEvent,
        data: { url: args.relayUrl, signature_secret: args.signatureSecret },
      }),
    },
    args.incomingRequest,
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    log.warn('events hook update failed', { status: response.status, detail: detail.slice(0, 300) });
    throw new HookApiError(response.status, detail);
  }
  return await response.json() as NetlifyHook;
}

/**
 * Clear a hook's error counter.
 *
 * Netlify disables a hook once `error_rate` exceeds 5 consecutive failures, and
 * a disabled hook stops firing silently and permanently. Re-enabling on refresh
 * is what keeps a subscription from being killed by a subscriber outage that
 * outlasted the retry budget.
 */
export async function enableSiteHook(hookId: string, incomingRequest: Request): Promise<boolean> {
  const response = await authenticatedFetch(
    `/api/v1/hooks/${encodeURIComponent(hookId)}/enable`,
    { method: 'POST' },
    incomingRequest,
    [404],
  );
  return response.ok;
}

export async function deleteSiteHook(hookId: string, incomingRequest: Request): Promise<boolean> {
  const response = await authenticatedFetch(
    `/api/v1/hooks/${encodeURIComponent(hookId)}`,
    { method: 'DELETE' },
    incomingRequest,
    [404],
  );
  // 404 is success for an unsubscribe: the hook is already gone.
  return response.ok || response.status === 404;
}
