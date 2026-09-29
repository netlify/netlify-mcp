// The events relay: Netlify's outgoing webhook in, the subscriber's signed
// webhook out.
//
// Stateless. Everything the relay needs arrives in the URL it is called at —
// `/events/relay/<subId>/<jwe>` — where the JWE seals the subscriber's callback
// URL, their signing secret, and the secret Netlify signed this delivery with.
// No datastore, no session, no lookup.
//
// See EVENTS_DESIGN.md for the whole model.

import type { Config, Context } from '@netlify/functions';

import {
  log,
  withLogContext,
  getRequestId,
  getDeployId,
  initLogger,
} from './mcp-server/logger.ts';
import { systemLogForwarder } from './mcp-server/system-log-forwarder.ts';
import { installProcessGuards } from './mcp-server/process-guards.ts';
import { openRelayToken, parseRelayPath, secureEquals } from './mcp-server/events/subscription.ts';
import { verifyNetlifySignature } from './mcp-server/events/signing.ts';
import { getEventDefinition } from './mcp-server/events/registry.ts';
import { matchesFilters, projectPayload, serializeDelivery } from './mcp-server/events/project-payload.ts';
import { deliverEvent } from './mcp-server/events/deliver.ts';

initLogger({ forward: systemLogForwarder });
installProcessGuards();

/**
 * 410 tells Netlify to destroy the hook (Hook#process_http_response). Used for
 * any subscription that can never succeed again — an unreadable relay token
 * (expired, or minted under a rotated JWE_SECRET), or an event we no longer
 * know about. That makes token expiry double as garbage collection.
 */
function gone(reason: string): Response {
  log.info('events relay releasing hook', { reason });
  return new Response(JSON.stringify({ error: reason }), {
    status: 410,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ok(status: number, detail: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: status < 300, ...detail }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);

  return withLogContext(
    {
      service: 'events-relay',
      requestId: getRequestId(req.headers),
      deployId: getDeployId(context),
      httpMethod: req.method,
    },
    async () => {
      if (req.method !== 'POST') {
        return ok(405, { error: 'method not allowed' });
      }

      const parsed = parseRelayPath(url.pathname);
      if (!parsed) {
        // Malformed path: never one of ours, so don't touch any hook state.
        return ok(404, { error: 'not found' });
      }

      const opened = await openRelayToken(parsed.jwe);

      // A misconfigured deployment must NOT take the 410 path: Netlify deletes a
      // hook that answers 410, so a missing key would wipe every subscription
      // on the platform. 503 keeps them alive and lets Netlify re-deliver once
      // the env var is set.
      if (opened.status === 'misconfigured') {
        log.error('events relay is misconfigured; refusing to release hooks', {
          envVar: opened.envVar,
          detail: opened.message,
        });
        return ok(503, { error: 'events relay is not configured' });
      }
      if (opened.status === 'unreadable') {
        return gone('relay token could not be read (expired or key rotated)');
      }
      const token = opened.token;
      // The subId is in the path AND sealed in the token; a mismatch means the
      // URL was assembled from parts of two different subscriptions.
      if (!secureEquals(token.subId, parsed.subId)) {
        return gone('relay token does not match its subscription id');
      }

      const definition = getEventDefinition(token.eventName);
      if (!definition) {
        return gone(`event "${token.eventName}" is no longer supported`);
      }

      const rawBody = await req.text();

      // Authenticate the delivery. The JWT signs a DIGEST of the body, so this
      // also re-derives the digest from the bytes we actually read.
      if (!verifyNetlifySignature({
        signature: req.headers.get('x-webhook-signature'),
        rawBody,
        secret: token.nsec,
      })) {
        log.warn('events relay rejected unsigned or mis-signed delivery', {
          subscriptionId: token.subId,
          netlifyEvent: req.headers.get('x-netlify-event'),
        });
        return ok(401, { error: 'invalid signature' });
      }

      let rawPayload: Record<string, any>;
      try {
        rawPayload = JSON.parse(rawBody);
      } catch {
        return ok(400, { error: 'invalid JSON body' });
      }

      const data = projectPayload(definition, rawPayload);

      // Filters Netlify can't apply: a site hook fires for every deploy of the
      // site, so branch/context narrowing happens here.
      if (!matchesFilters(definition, data, token.filters)) {
        log.debug('events relay filtered out delivery', {
          subscriptionId: token.subId,
          eventName: token.eventName,
        });
        return ok(202, { filtered: true });
      }

      // Stable across every retry — ours and Netlify's — so the subscriber can
      // dedupe. Derived, not random, precisely so it survives a cold start.
      const payloadId = typeof rawPayload.id === 'string' ? rawPayload.id : 'unknown';
      const eventId = `evt_${token.subId}_${token.netlifyEvent}_${payloadId}`;

      const { body, oversize } = serializeDelivery({
        eventId,
        name: token.eventName,
        timestamp: new Date().toISOString(),
        data,
        cursor: null,
      });

      if (oversize) {
        log.warn('events relay dropping oversize delivery', {
          subscriptionId: token.subId,
          eventName: token.eventName,
          bytes: Buffer.byteLength(body, 'utf8'),
        });
        return ok(202, { dropped: 'oversize' });
      }

      log.info('events relay delivering', {
        subscriptionId: token.subId,
        eventName: token.eventName,
        netlifyEvent: token.netlifyEvent,
        siteId: token.siteId,
        eventId,
      });

      const outcome = await deliverEvent({
        callbackUrl: token.cb,
        secret: token.whsec,
        subscriptionId: token.subId,
        eventId,
        body,
      });

      log.info('events relay delivered', {
        subscriptionId: token.subId,
        eventId,
        delivered: outcome.delivered,
        attempts: outcome.attempts,
        subscriberStatus: outcome.lastStatus,
        relayStatus: outcome.relayStatus,
        reason: outcome.reason,
      });

      if (outcome.relayStatus === 410) {
        return gone('subscriber reported the subscription is gone');
      }
      return ok(outcome.relayStatus, {
        delivered: outcome.delivered,
        attempts: outcome.attempts,
      });
    },
  );
};

export const config: Config = {
  path: '/events/relay/*',
};
