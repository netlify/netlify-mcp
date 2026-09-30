// Outbound delivery of one event to one subscriber, with bounded retries.
//
// Retry policy is shaped by how bitballoon treats our responses
// (Hook#process_http_response):
//
//   2xx  -> success; ALSO resets the hook's error_rate to 0
//   410  -> the hook is DESTROYED. We use this deliberately: a dead
//           subscription self-cleans instead of firing forever.
//   403,
//   404  -> marks the hook unsuccessful, but does not disable it
//   else -> error_rate++ and the delivery is re-queued by
//           Hook::TriggerWorker (sidekiq retry: 5)
//
// and by ERROR_THRESSHOLD = 5: once error_rate exceeds 5 the hook is disabled
// and silently stops firing. Crucially error_rate only accumulates across
// CONSECUTIVE failures — a single success resets it — so propagating a failure
// to Netlify is safe for a flaky endpoint and only fatal for a sustained
// outage. We therefore make a few fast attempts ourselves (cheap, covers the
// common blip) and then hand a 503 to Netlify so its durable queue takes over,
// rather than swallowing the error and losing the event entirely.

import { log } from '../logger.ts';
import { signOutboundDelivery } from './signing.ts';
import { checkCallbackUrl } from './callback-guard.ts';

export interface DeliveryOutcome {
  /** What the relay should answer Netlify with. */
  relayStatus: number;
  delivered: boolean;
  attempts: number;
  lastStatus?: number;
  reason?: string;
}

/** Inline attempt, then these backoffs. Kept short: the whole sequence has to
 *  fit inside the function's lifetime, and Netlify's own queue is the durable
 *  layer behind us. */
const RETRY_DELAYS_MS = [700, 2_500];
const ATTEMPT_TIMEOUT_MS = 4_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deliver one event. `eventId` MUST be stable across every attempt (the
 * extension requires preserving it so subscribers can dedupe); the timestamp and
 * signature are regenerated per attempt, which is why signing happens inside
 * the loop.
 */
export async function deliverEvent(args: {
  callbackUrl: string;
  secret: string;
  subscriptionId: string;
  eventId: string;
  body: string;
}): Promise<DeliveryOutcome> {
  // Re-check the callback on every delivery, not just at subscribe time: the
  // hostname could have been re-pointed at private address space since.
  const guard = await checkCallbackUrl(args.callbackUrl);
  if (!guard.ok) {
    log.warn('events delivery blocked by callback guard', {
      subscriptionId: args.subscriptionId,
      reason: guard.reason,
    });
    // Not retryable, and not the subscriber's transient problem — drop it but
    // keep the hook, so a re-pointed DNS record can recover.
    return { relayStatus: 202, delivered: false, attempts: 0, reason: guard.reason };
  }

  let attempts = 0;
  let lastStatus: number | undefined;

  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    if (i > 0) await sleep(RETRY_DELAYS_MS[i - 1]);
    attempts++;

    const headers = signOutboundDelivery({
      eventId: args.eventId,
      subscriptionId: args.subscriptionId,
      body: args.body,
      secret: args.secret,
    });
    if (!headers) {
      return { relayStatus: 202, delivered: false, attempts, reason: 'bad-secret' };
    }

    let response: Response;
    try {
      response = await fetch(args.callbackUrl, {
        method: 'POST',
        headers,
        body: args.body,
        redirect: 'error',
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
    } catch (error) {
      log.debug('events delivery attempt failed to connect', {
        subscriptionId: args.subscriptionId,
        attempt: attempts,
        err: error,
      });
      continue;
    }

    lastStatus = response.status;

    if (response.ok) {
      return { relayStatus: 202, delivered: true, attempts, lastStatus };
    }

    // The subscription is gone on the client's side. Pass 410 through so
    // Netlify destroys the hook — this is the garbage-collection path.
    if (response.status === 410) {
      log.info('events subscriber reported gone; releasing hook', {
        subscriptionId: args.subscriptionId,
      });
      return { relayStatus: 410, delivered: false, attempts, lastStatus };
    }

    // Payload too large: never retryable per the extension.
    if (response.status === 413) {
      log.warn('events delivery rejected as too large', {
        subscriptionId: args.subscriptionId,
        bytes: Buffer.byteLength(args.body, 'utf8'),
      });
      return { relayStatus: 202, delivered: false, attempts, lastStatus, reason: 'too-large' };
    }

    // 408 and 429 are 4xx but transient — a request timeout and a rate limit
    // both succeed on a later attempt — so they take the retry path alongside
    // 5xx. Every other 4xx is a client-side problem a retry won't fix.
    if (response.status >= 400 && response.status < 500
        && response.status !== 408 && response.status !== 429) {
      return { relayStatus: 202, delivered: false, attempts, lastStatus, reason: 'client-error' };
    }
    // 5xx, 408, 429: fall through and retry.
  }

  log.warn('events delivery exhausted inline attempts; deferring to netlify queue', {
    subscriptionId: args.subscriptionId,
    attempts,
    lastStatus,
  });
  // Hand it back to Netlify so its own retry queue re-delivers. A 503 costs one
  // error_rate increment, which the next successful delivery resets.
  return { relayStatus: 503, delivered: false, attempts, lastStatus, reason: 'exhausted' };
}
