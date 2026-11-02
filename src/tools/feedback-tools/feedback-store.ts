// Write-only persistence for MCP feedback reports.
//
// Reports go to a site-wide Netlify Blobs store on the site that hosts the
// remote MCP server. This module deliberately exposes NO way to read a report
// back: the only read is a key count under the caller's own prefix, used to
// enforce the per-user cap. Reviewing feedback happens out of band (the Netlify
// UI/CLI/API for the site's blobs, or the observability log line), never
// through the MCP server.

export const FEEDBACK_STORE_NAME = 'mcp-feedback';

export interface FeedbackStore {
  /** How many reports this user has already filed on the given UTC day. */
  countForUserOnDay(day: string, userId: string): Promise<number>;
  /** Persist one report. */
  save(key: string, record: Record<string, unknown>): Promise<void>;
}

// Keys are `reports/<YYYY-MM-DD>/<userId>/<timestamp>-<id>`: date-first so a
// reviewer can list one day's feedback, user-second so the cap is one prefix
// list.
export const userDayPrefix = (day: string, userId: string) =>
  `reports/${day}/${encodeURIComponent(userId)}/`;

export const feedbackKey = (day: string, userId: string, timestamp: number, id: string) =>
  `${userDayPrefix(day, userId)}${timestamp}-${id}`;

// The blobs context is supplied by the function runtime per invocation, so the
// store handle is resolved on each call rather than cached at module load.
const openBlobsStore = async () => {
  // Imported lazily so the stdio CLI bundle, which never registers this tool,
  // does not load the blobs client at startup.
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: FEEDBACK_STORE_NAME, consistency: 'strong' });
};

const blobsFeedbackStore: FeedbackStore = {
  async countForUserOnDay(day, userId) {
    const store = await openBlobsStore();
    const { blobs } = await store.list({ prefix: userDayPrefix(day, userId) });
    return blobs.length;
  },
  async save(key, record) {
    const store = await openBlobsStore();
    await store.setJSON(key, record);
  },
};

let storeOverride: FeedbackStore | null = null;

export const getFeedbackStore = (): FeedbackStore => storeOverride ?? blobsFeedbackStore;

/** Swap the backing store in tests. Pass null to restore the default. */
export const setFeedbackStoreForTests = (store: FeedbackStore | null) => {
  storeOverride = store;
};
