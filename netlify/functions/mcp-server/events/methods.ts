// `events/list`, `events/subscribe` and `events/unsubscribe`.
//
// These are not MCP spec methods — they are OpenAI's events extension
// (https://developers.openai.com/plugins/build/mcp-events), which the MCP SDK
// does not implement at any version. They are registered as custom methods
// through the SDK's 3-arg `setRequestHandler(method, schemas, handler)`, so the
// SDK still owns parsing, dispatch and JSON-RPC error mapping; only the
// vocabulary is ours.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { randomBytes } from 'node:crypto';

import { log } from '../logger.ts';
import { getEventDefinition, listEvents } from './registry.ts';
import {
  computeSubscriptionId,
  generateNetlifySigningSecret,
  relayPath,
  sealRelayToken,
  SUBSCRIPTION_TTL_MS,
  type EventFilters,
} from './subscription.ts';
import { decodeWebhookSecret } from './signing.ts';
import { verifyCallbackUrl } from './callback-guard.ts';
import {
  createSiteHook,
  deleteSiteHook,
  enableSiteHook,
  findHookBySubscriptionId,
  getSiteHookTypes,
  listSiteHooks,
  resolveSite,
  resolveSubscriberUserId,
  updateSiteHook,
} from './hooks-api.ts';
import { getServerBaseUrl } from './base-url.ts';
import { MissingJWEKeyError } from '../utils.ts';

// JSON-RPC error codes we return. -32602 is INVALID_PARAMS; the extension does
// not define codes of its own, so every caller-fixable refusal uses it with a
// message written to be read by a model and relayed to a person.
const INVALID_PARAMS = -32602;

class EventsError extends Error {
  code: number;
  constructor(message: string, code = INVALID_PARAMS) {
    super(message);
    this.code = code;
  }
}

const DeliverySchema = z.object({
  mode: z.literal('webhook'),
  url: z.string(),
  secret: z.string().optional(),
});

const SubscribeParamsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  delivery: DeliverySchema,
  cursor: z.string().nullish(),
  ttlMs: z.number().positive().optional(),
});

const UnsubscribeParamsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  delivery: z.object({ mode: z.literal('webhook'), url: z.string() }),
});

function normalizeFilters(args: Record<string, unknown> | undefined): EventFilters {
  const filters: EventFilters = {};
  if (typeof args?.branch === 'string' && args.branch) filters.branch = args.branch;
  if (typeof args?.context === 'string' && args.context) filters.context = args.context;
  return filters;
}

/**
 * Validate everything that can be checked from the request alone.
 *
 * Deliberately ordered before any auth or network work: these are the failures
 * a caller can actually fix, so reporting them first gives the model a useful
 * message instead of an incidental one, and avoids spending API calls on a
 * request that was never going to succeed.
 */
function validateSubscriptionParams(params: { name: string; arguments?: Record<string, unknown> }) {
  const def = getEventDefinition(params.name);
  if (!def) {
    throw new EventsError(
      `Unknown event "${params.name}". Call events/list for the supported event names.`,
    );
  }

  const siteArg = params.arguments?.site;
  if (typeof siteArg !== 'string' || !siteArg) {
    throw new EventsError('The "site" argument is required: a site ID, name, or slug.');
  }

  return { def, siteArg };
}

/**
 * Resolve the validated request against Netlify: who is asking, and which site.
 * Both steps need the network, so they run after the cheap validation above.
 */
async function resolveSubscriptionTarget(
  params: { name: string; arguments?: Record<string, unknown> },
  req: Request,
) {
  const { def, siteArg } = validateSubscriptionParams(params);

  // Must work for BOTH bearer shapes: an OAuth-minted JWE and a raw personal
  // access token. Using the JWE-embedded identity alone made events/subscribe
  // fail outright for every PAT user.
  const userId = await resolveSubscriberUserId(req);
  if (!userId) {
    throw new EventsError('Could not identify the authenticated Netlify user.', -32603);
  }

  const site = await resolveSite(siteArg, req);
  if (!site?.id) {
    throw new EventsError(
      `No site found matching "${siteArg}". Use a site ID, or the exact site name.`,
    );
  }

  return { def, userId, site };
}

/**
 * Check that the event will actually fire for this site before we create a hook
 * for it.
 *
 * This matters because the gate is silent: in bitballoon a restricted event is
 * skipped at trigger time (`Hook#restricted?`), so the hook is created happily
 * and then never delivers. `GET /hooks/types?site_id=` reports both the
 * available and the restricted events for the site, which is the only way to
 * know before the fact.
 */
async function assertEventAvailable(
  netlifyEvent: string,
  eventName: string,
  siteId: string,
  req: Request,
): Promise<void> {
  let types;
  try {
    types = await getSiteHookTypes(siteId, req);
  } catch (error) {
    // Don't fail a subscription because the entitlement probe broke; the worst
    // case is a hook that doesn't fire, which is the pre-existing behavior.
    log.warn('events entitlement probe failed; allowing subscribe', { err: error, siteId });
    return;
  }

  const urlType = types.find((t) => t.name === 'url');
  if (!urlType) {
    log.warn('events entitlement probe found no url hook type; allowing subscribe', { siteId });
    return;
  }

  if (urlType.restricted_events?.includes(netlifyEvent)) {
    throw new EventsError(
      `The "${eventName}" event is not available for this site's team plan, so Netlify ` +
      `would accept the subscription but never deliver it. Upgrade the team or choose ` +
      `a different event.`,
    );
  }
  if (urlType.events?.length && !urlType.events.includes(netlifyEvent)) {
    throw new EventsError(
      `The "${eventName}" event is not enabled for this site. Choose a different event.`,
    );
  }
}

async function handleSubscribe(
  params: z.infer<typeof SubscribeParamsSchema>,
  req: Request,
) {
  // Cheap, caller-fixable checks first — before auth, before any API call.
  validateSubscriptionParams(params);

  // The extension specifies a `whsec_` secret whose base64 decodes to 24–64
  // bytes. Validate once here so a malformed secret fails the subscription
  // rather than silently failing every delivery.
  if (!params.delivery.secret || !decodeWebhookSecret(params.delivery.secret)) {
    throw new EventsError(
      'delivery.secret must be a "whsec_"-prefixed signing secret whose base64 value decodes to 24-64 bytes.',
    );
  }

  const { def, userId, site } = await resolveSubscriptionTarget(params, req);

  const filters = normalizeFilters(params.arguments);
  const identity = {
    userId,
    eventName: params.name,
    siteId: site.id,
    filters,
    callbackUrl: params.delivery.url,
  };
  const subId = computeSubscriptionId(identity);

  await assertEventAvailable(def.netlifyEvent, params.name, site.id, req);

  // Verify the callback before storing anything. The extension requires this
  // handshake, and doing it first means a bad callback never leaves a hook
  // behind on the site.
  const verification = await verifyCallbackUrl({
    callbackUrl: params.delivery.url,
    secret: params.delivery.secret,
    subscriptionId: subId,
    challenge: randomBytes(24).toString('base64url'),
  });
  if (!verification.ok) {
    throw new EventsError(
      `Could not verify the delivery callback URL (${verification.reason}). ` +
      'It must be an HTTPS URL on a public address that echoes the verification challenge.',
    );
  }

  const signatureSecret = generateNetlifySigningSecret();
  let jwe: string;
  try {
    jwe = await sealRelayToken({
      subId,
      userId,
      eventName: params.name,
      netlifyEvent: def.netlifyEvent,
      siteId: site.id,
      filters,
      cb: params.delivery.url,
      whsec: params.delivery.secret,
      nsec: signatureSecret,
    });
  } catch (error) {
    // The relay key is missing or misconfigured. That is an operator problem,
    // not a caller problem: log the actionable detail and tell the client
    // something true but unactionable, rather than leaking deployment
    // configuration into a conversation.
    if (error instanceof MissingJWEKeyError) {
      log.error('events subscribe blocked: relay key not configured', {
        envVar: error.envVar,
        detail: error.message,
      });
      throw new EventsError(
        'Event subscriptions are not available on this server right now. This is a ' +
        'server configuration problem, not a problem with the request.',
        -32603,
      );
    }
    throw error;
  }
  const relayUrl = `${getServerBaseUrl(req)}${relayPath(subId, jwe)}`;

  // Idempotency + refresh in one step: the deterministic subId lets us find the
  // hook this subscription already owns, so a re-subscribe updates it in place
  // instead of accumulating duplicates.
  const existing = findHookBySubscriptionId(
    await listSiteHooks(site.id, def.netlifyEvent, req),
    subId,
  );

  try {
    if (existing) {
      await updateSiteHook({
        hookId: existing.id,
        netlifyEvent: def.netlifyEvent,
        relayUrl,
        signatureSecret,
        incomingRequest: req,
      });
      // A refresh is the moment to undo a disable: six consecutive delivery
      // failures make Netlify disable the hook, after which it never fires
      // again on its own.
      if (existing.disabled) {
        await enableSiteHook(existing.id, req);
        log.info('events re-enabled a disabled hook on refresh', {
          subscriptionId: subId,
          hookId: existing.id,
        });
      }
    } else {
      await createSiteHook({
        siteId: site.id,
        netlifyEvent: def.netlifyEvent,
        relayUrl,
        signatureSecret,
        incomingRequest: req,
      });
    }
  } catch (error: any) {
    // Creating a notification hook requires update access on the site, not just
    // read — a read-only collaborator lands here.
    if (error?.status === 403) {
      throw new EventsError(
        'You need write access to this site to subscribe to its events.',
      );
    }
    // A 422 is a validation refusal with Netlify's own explanation attached;
    // relaying it beats a generic failure.
    if (error?.status === 422 && error?.detail) {
      throw new EventsError(`Netlify rejected the subscription: ${String(error.detail).slice(0, 300)}`);
    }
    throw error;
  }

  log.info('events subscribed', {
    subscriptionId: subId,
    eventName: params.name,
    netlifyEvent: def.netlifyEvent,
    siteId: site.id,
    refreshed: !!existing,
    hasBranchFilter: !!filters.branch,
    hasContextFilter: !!filters.context,
  });

  // `ttlMs`, when the client asks for one, caps the grant.
  const ttlMs = Math.min(params.ttlMs ?? SUBSCRIPTION_TTL_MS, SUBSCRIPTION_TTL_MS);

  return {
    id: subId,
    refreshBefore: new Date(Date.now() + ttlMs).toISOString(),
    // Netlify's outgoing hooks keep no history, so there is nothing to replay
    // from. Events that occur while a subscription is lapsed are lost.
    cursor: null,
    truncated: false,
  };
}

async function handleUnsubscribe(
  params: z.infer<typeof UnsubscribeParamsSchema>,
  req: Request,
) {
  const { def, userId, site } = await resolveSubscriptionTarget(params, req);

  const subId = computeSubscriptionId({
    userId,
    eventName: params.name,
    siteId: site.id,
    filters: normalizeFilters(params.arguments),
    callbackUrl: params.delivery.url,
  });

  const existing = findHookBySubscriptionId(
    await listSiteHooks(site.id, def.netlifyEvent, req),
    subId,
  );

  if (existing) {
    await deleteSiteHook(existing.id, req);
  }

  log.info('events unsubscribed', {
    subscriptionId: subId,
    eventName: params.name,
    siteId: site.id,
    // An unsubscribe for something already gone is still a success.
    found: !!existing,
  });

  return {};
}

/**
 * Register the events extension on a per-request server instance.
 *
 * `registerCapabilities` is what makes the extension discoverable: the SDK
 * advertises capabilities verbatim on both `initialize` and `server/discover`
 * (`discoverAdvertisedCapabilities` is a plain spread, with no schema strip), so
 * an off-spec key survives to the wire. The cast is needed only because
 * `ServerCapabilities` is typed to the spec's known keys.
 */
export function registerEventMethods(server: McpServer, req: Request): void {
  server.server.registerCapabilities({ events: {} } as Record<string, unknown>);

  server.server.setRequestHandler(
    'events/list',
    { params: z.object({}).loose() },
    async () => listEvents(),
  );

  server.server.setRequestHandler(
    'events/subscribe',
    { params: SubscribeParamsSchema },
    async (params) => handleSubscribe(params, req),
  );

  server.server.setRequestHandler(
    'events/unsubscribe',
    { params: UnsubscribeParamsSchema },
    async (params) => handleUnsubscribe(params, req),
  );
}

export { EventsError };
