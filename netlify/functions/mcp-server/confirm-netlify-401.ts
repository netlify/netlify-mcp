import { getNetlifyAccessToken, unauthenticatedFetch } from '../../../src/utils/api-networking.ts';
import { log } from './logger.ts';

// A 401 inside a tool is not proof of a bad token, so the handler asks the
// Netlify API once, with the same token. When unsure, answer false: a wrong
// sign-in prompt discards the tool result, a missed one costs a single call.
const CONFIRM_TIMEOUT_MS = 3000;

/**
 * True only when `/api/v1/user` itself answers 401 for the request's token.
 * Never throws; any other outcome (200, other status, error, timeout) is false.
 */
export async function netlifyRejectedToken(req: Request, rejectedPath: string): Promise<boolean> {
  let outcome: 'rejected' | 'token-valid' | 'inconclusive' = 'inconclusive';
  try {
    const token = await getNetlifyAccessToken(req);
    const response = await unauthenticatedFetch('https://api.netlify.com/api/v1/user', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(CONFIRM_TIMEOUT_MS),
    });
    if (response.status === 401) outcome = 'rejected';
    else if (response.status === 200) outcome = 'token-valid';
  } catch {
    // Token resolution failed, or the call errored or timed out.
  }

  if (outcome === 'rejected') {
    log.warn('netlify api returned 401 during tool execution; issuing auth challenge', { apiPath: rejectedPath });
  } else {
    log.warn('netlify api returned 401 during tool execution; not issuing auth challenge', { apiPath: rejectedPath, outcome });
  }
  return outcome === 'rejected';
}
