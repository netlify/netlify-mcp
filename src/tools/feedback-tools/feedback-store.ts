// Write-only persistence for MCP feedback reports.
//
// Production reports go to a site-wide Netlify Blobs store on the site that
// hosts the remote MCP server. Deploy previews and branch deploys write to a
// deploy-scoped store instead, so test traffic never lands in (or counts
// against) the production feedback.
//
// This module deliberately exposes NO way to read a report back. Reviewing
// feedback happens out of band (the Netlify UI/CLI/API for the site's blobs, or
// the observability log line), never through the MCP server.

export const FEEDBACK_STORE_NAME = 'mcp-feedback';

export type SaveResult =
  | { saved: true; key: string; slot: number }
  | { saved: false; reason: 'daily-limit' };

export interface FeedbackStore {
  /**
   * Persist one report in the first free daily slot for this user. Returns
   * `daily-limit` when all `maxPerDay` slots are already taken.
   */
  saveInDailySlot(
    day: string,
    userId: string,
    maxPerDay: number,
    record: Record<string, unknown>,
  ): Promise<SaveResult>;
}

// Keys are `reports/<YYYY-MM-DD>/<userId>/<slot>`: date-first so a reviewer can
// list one day's feedback, then user, then a zero-padded slot number.
export const userDayPrefix = (day: string, userId: string) =>
  `reports/${day}/${encodeURIComponent(userId)}/`;

export const feedbackSlotKey = (day: string, userId: string, slot: number) =>
  `${userDayPrefix(day, userId)}${String(slot).padStart(3, '0')}`;

type DeployContext = string | undefined;

// The v2 function runtime exposes the deploy context on the `Netlify` global.
export const currentDeployContext = (): DeployContext =>
  (globalThis as any).Netlify?.context?.deploy?.context;

// Only the two non-production contexts are split off. Anything else, including
// an unknown context, uses the site store, so production feedback can never be
// sent somewhere hard to find by mistake.
const usesDeployStore = (context: DeployContext) =>
  context === 'deploy-preview' || context === 'branch-deploy';

// The blobs context is supplied by the function runtime per invocation, so the
// store handle is resolved on each call rather than cached at module load.
const openBlobsStore = async () => {
  // Imported lazily so the stdio CLI bundle, which never registers this tool,
  // does not load the blobs client at startup.
  const { getStore, getDeployStore } = await import('@netlify/blobs');
  return usesDeployStore(currentDeployContext())
    ? getDeployStore({ name: FEEDBACK_STORE_NAME })
    : getStore({ name: FEEDBACK_STORE_NAME, consistency: 'strong' });
};

/** The two Blobs operations slot claiming needs. */
export interface SlotStore {
  list(options: { prefix: string }): Promise<{ blobs: { key: string }[] }>;
  setJSON(key: string, value: unknown, options: { onlyIfNew: true }): Promise<{ modified: boolean }>;
}

/**
 * Write `record` into the first free slot for this user and day.
 *
 * Starts at the first slot not yet listed, so the usual case is one write.
 * Every write is `onlyIfNew`: when concurrent calls race for the same slot,
 * exactly one wins and the rest move on to the next one. That keeps the cap
 * exact however many calls arrive at once.
 */
export const claimDailySlot = async (
  store: SlotStore,
  day: string,
  userId: string,
  maxPerDay: number,
  record: Record<string, unknown>,
): Promise<SaveResult> => {
  const { blobs } = await store.list({ prefix: userDayPrefix(day, userId) });
  for (let slot = Math.min(blobs.length, maxPerDay); slot < maxPerDay; slot++) {
    const key = feedbackSlotKey(day, userId, slot);
    const { modified } = await store.setJSON(key, record, { onlyIfNew: true });
    if (modified) return { saved: true, key, slot };
  }
  return { saved: false, reason: 'daily-limit' };
};

const blobsFeedbackStore: FeedbackStore = {
  async saveInDailySlot(day, userId, maxPerDay, record) {
    return claimDailySlot(await openBlobsStore(), day, userId, maxPerDay, record);
  },
};

let storeOverride: FeedbackStore | null = null;

export const getFeedbackStore = (): FeedbackStore => storeOverride ?? blobsFeedbackStore;

/** Swap the backing store in tests. Pass null to restore the default. */
export const setFeedbackStoreForTests = (store: FeedbackStore | null) => {
  storeOverride = store;
};
