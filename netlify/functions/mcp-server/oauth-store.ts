import { getStore, type Store } from "@netlify/blobs";
import type { TokenIdentity } from "./identity.ts";
import { log } from "./logger.ts";

// Durable state for the OAuth server: the authorization transaction a browser
// is in the middle of, the grant a user gave a client, and the one-time record
// that an authorization code was redeemed. The functions run as independent
// serverless instances, so the only thing that makes "redeem once" or "rotate
// once" true is a store with conditional writes shared by all of them. Netlify
// Blobs gives us that (`onlyIfNew`, `onlyIfMatch`) with strong reads; the
// in-memory store exists for the test suite and for `netlify dev` without a
// Blobs context, and is refused anywhere else.
//
// A store failure is a refusal, never a pass: every caller turns
// OAuthStorageError into a 503 that names the store, because a server that
// cannot see whether a code was already used must not issue tokens for it.

export const STORE_NAME = 'oauth-grants';
export const RECORD_VERSION = 1;

// Long enough for a Netlify login with 2FA or SSO after consent.
export const TRANSACTION_TTL_MS = 20 * 60 * 1000;
export const CODE_REDEMPTION_TTL_MS = 20 * 60 * 1000;
export const REFRESH_RACE_GRACE_MS = 30 * 1000;

export type TransactionStatus = 'pending' | 'approved' | 'declined' | 'completed';

export interface AuthTransaction {
  v: number;
  id: string;
  /** sha256 of the browser session secret the transaction was created for. */
  sessionHash: string;
  client_id: string;
  client_source: 'static' | 'stateless';
  client_name?: string;
  redirect_uri: string;
  code_challenge: string;
  /** The client's own `state`, carried to its callback and nowhere else. */
  state?: string;
  scope?: string;
  nonce?: string;
  resource?: string;
  status: TransactionStatus;
  createdAt: number;
  expiresAt: number;
  approvedAt?: number;
}

export interface Grant {
  v: number;
  id: string;
  client_id: string;
  redirect_uri: string;
  scope?: string;
  identity?: TokenIdentity;
  transaction: string;
  createdAt: number;
  /** jti of the refresh token that is currently valid; null once revoked or if none was issued. */
  currentRefresh: string | null;
  /** The refresh token rotated out most recently and when, so a client's own
   * parallel refresh inside REFRESH_RACE_GRACE_MS is a lost race, not reuse. */
  previousRefresh?: { jti: string; at: number };
  revoked: { at: number; reason: string } | null;
}

export interface Versioned<T> {
  record: T;
  etag: string;
}

export class OAuthStorageError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'OAuthStorageError';
    this.cause = cause;
  }
}

export interface OAuthStore {
  putTransaction(txn: AuthTransaction): Promise<void>;
  getTransaction(id: string): Promise<Versioned<AuthTransaction> | null>;
  /** Compare-and-swap; false when the record moved since `etag` was read. */
  updateTransaction(txn: AuthTransaction, etag: string): Promise<boolean>;
  putGrant(grant: Grant): Promise<void>;
  getGrant(id: string): Promise<Versioned<Grant> | null>;
  updateGrant(grant: Grant, etag: string): Promise<boolean>;
  /** True exactly once per jti, however many instances race on it. */
  redeemCode(jti: string): Promise<boolean>;
}

const keys = {
  transaction: (id: string) => `txn/${id}`,
  grant: (id: string) => `grant/${id}`,
  code: (jti: string) => `code/${jti}`,
};

function wrap<T>(operation: string, work: () => Promise<T>): Promise<T> {
  return work().catch((error) => {
    log.error('oauth store unavailable', { operation, err: error });
    throw new OAuthStorageError(`OAuth store (Netlify Blobs store "${STORE_NAME}") failed during ${operation}; refusing to continue without it`, error);
  });
}

export class BlobsOAuthStore implements OAuthStore {
  private readonly store: Store;

  constructor(store?: Store) {
    this.store = store ?? getStore({ name: STORE_NAME, consistency: supportsStrongReads() ? 'strong' : 'eventual' });
  }

  putTransaction(txn: AuthTransaction): Promise<void> {
    return wrap('putTransaction', async () => {
      const { modified } = await this.store.set(keys.transaction(txn.id), JSON.stringify(txn), {
        onlyIfNew: true,
        metadata: { expiresAt: txn.expiresAt },
      });
      if (!modified) throw new Error('transaction id already exists');
    });
  }

  getTransaction(id: string): Promise<Versioned<AuthTransaction> | null> {
    return wrap('getTransaction', () => this.read<AuthTransaction>(keys.transaction(id)));
  }

  updateTransaction(txn: AuthTransaction, etag: string): Promise<boolean> {
    return wrap('updateTransaction', async () => {
      const { modified } = await this.store.set(keys.transaction(txn.id), JSON.stringify(txn), {
        onlyIfMatch: etag,
        metadata: { expiresAt: txn.expiresAt },
      });
      return modified;
    });
  }

  putGrant(grant: Grant): Promise<void> {
    return wrap('putGrant', async () => {
      const { modified } = await this.store.set(keys.grant(grant.id), JSON.stringify(grant), { onlyIfNew: true });
      if (!modified) throw new Error('grant id already exists');
    });
  }

  getGrant(id: string): Promise<Versioned<Grant> | null> {
    return wrap('getGrant', () => this.read<Grant>(keys.grant(id)));
  }

  updateGrant(grant: Grant, etag: string): Promise<boolean> {
    return wrap('updateGrant', async () => {
      const { modified } = await this.store.set(keys.grant(grant.id), JSON.stringify(grant), { onlyIfMatch: etag });
      return modified;
    });
  }

  redeemCode(jti: string): Promise<boolean> {
    return wrap('redeemCode', async () => {
      const { modified } = await this.store.set(keys.code(jti), String(Date.now()), {
        onlyIfNew: true,
        metadata: { expiresAt: Date.now() + CODE_REDEMPTION_TTL_MS },
      });
      return modified;
    });
  }

  private async read<T>(key: string): Promise<Versioned<T> | null> {
    const result = await this.store.getWithMetadata(key, { type: 'json' });
    if (!result || result.data === null || result.data === undefined) return null;
    if (!result.etag) throw new Error(`no etag returned for ${key}`);
    return { record: result.data as T, etag: result.etag };
  }
}

export class MemoryOAuthStore implements OAuthStore {
  private readonly records = new Map<string, { value: string; etag: string }>();
  private counter = 0;

  private nextEtag(): string {
    this.counter += 1;
    return `"${this.counter}"`;
  }

  private putIfNew(key: string, value: string): boolean {
    if (this.records.has(key)) return false;
    this.records.set(key, { value, etag: this.nextEtag() });
    return true;
  }

  private putIfMatch(key: string, value: string, etag: string): boolean {
    const current = this.records.get(key);
    if (!current || current.etag !== etag) return false;
    this.records.set(key, { value, etag: this.nextEtag() });
    return true;
  }

  private read<T>(key: string): Versioned<T> | null {
    const current = this.records.get(key);
    return current ? { record: JSON.parse(current.value) as T, etag: current.etag } : null;
  }

  async putTransaction(txn: AuthTransaction): Promise<void> {
    if (!this.putIfNew(keys.transaction(txn.id), JSON.stringify(txn))) throw new OAuthStorageError('transaction id already exists');
  }
  async getTransaction(id: string) { return this.read<AuthTransaction>(keys.transaction(id)); }
  async updateTransaction(txn: AuthTransaction, etag: string) { return this.putIfMatch(keys.transaction(txn.id), JSON.stringify(txn), etag); }
  async putGrant(grant: Grant): Promise<void> {
    if (!this.putIfNew(keys.grant(grant.id), JSON.stringify(grant))) throw new OAuthStorageError('grant id already exists');
  }
  async getGrant(id: string) { return this.read<Grant>(keys.grant(id)); }
  async updateGrant(grant: Grant, etag: string) { return this.putIfMatch(keys.grant(grant.id), JSON.stringify(grant), etag); }
  async redeemCode(jti: string) { return this.putIfNew(keys.code(jti), String(Date.now())); }
}

/**
 * Strong reads need the uncached edge URL, which the environment context
 * carries when Netlify configures Blobs itself but which `connectLambda`
 * (used by the Lambda-compatibility OAuth function) does not set. Writes are
 * unaffected: `onlyIfNew` and `onlyIfMatch` are enforced by the service, so
 * single-use and compare-and-swap hold either way; without strong reads a
 * stale read only costs a retry (the write is refused), never a double issue.
 */
function supportsStrongReads(): boolean {
  const raw = (globalThis as { netlifyBlobsContext?: string }).netlifyBlobsContext ?? process.env.NETLIFY_BLOBS_CONTEXT;
  if (!raw) return true;
  try {
    const context = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as { uncachedEdgeURL?: string; edgeURL?: string };
    if (context.uncachedEdgeURL) return true;
    log.warn('oauth store: no uncached edge URL in the Blobs context, using eventual reads');
    return false;
  } catch {
    return true;
  }
}

let activeStore: OAuthStore | null = null;

function isLocalIssuer(): boolean {
  const issuer = process.env.OAUTH_ISSUER;
  if (!issuer) {
    // A Netlify deploy always has these; a missing OAUTH_ISSUER there is a
    // misconfiguration, not a local run.
    return !(process.env.NETLIFY === 'true' || process.env.DEPLOY_ID);
  }
  try {
    const host = new URL(issuer).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * The store for this process. `OAUTH_STORE=memory` selects the in-memory store
 * explicitly (tests, local runs); otherwise Netlify Blobs, which configures
 * itself from the function context on Netlify and under `netlify dev`. Without
 * a Blobs context the in-memory store is used only for a localhost issuer —
 * a deployed instance without durable storage refuses to run the OAuth flow.
 */
export function getOAuthStore(): OAuthStore {
  if (activeStore) return activeStore;

  if (process.env.OAUTH_STORE === 'memory') {
    if (!isLocalIssuer()) {
      throw new OAuthStorageError('OAUTH_STORE=memory is only allowed with a localhost OAUTH_ISSUER: the in-memory store cannot make authorization codes single-use across instances');
    }
    activeStore = new MemoryOAuthStore();
    return activeStore;
  }

  try {
    activeStore = new BlobsOAuthStore();
    return activeStore;
  } catch (error) {
    if (isLocalIssuer()) {
      log.warn('oauth store: no Netlify Blobs context, using the in-memory store because the issuer is localhost');
      activeStore = new MemoryOAuthStore();
      return activeStore;
    }
    throw new OAuthStorageError('Netlify Blobs is not available to this function, so the OAuth server cannot persist grants. Deploy on Netlify (Blobs is enabled automatically) or run under `netlify dev`.', error);
  }
}

/** Test seam: replace the process-wide store. Pass null to re-resolve. */
export function setOAuthStore(store: OAuthStore | null): void {
  activeStore = store;
}

export function revokedGrant(grant: Grant, reason: string): Grant {
  return { ...grant, currentRefresh: null, revoked: { at: Date.now(), reason } };
}

/**
 * Mark a grant revoked. Retries the compare-and-swap a few times because
 * revocation must win against a concurrent rotation; gives up quietly if the
 * grant is already revoked.
 */
export async function revokeGrant(store: OAuthStore, grantId: string, reason: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const found = await store.getGrant(grantId);
    if (!found || found.record.revoked) return;
    if (await store.updateGrant(revokedGrant(found.record, reason), found.etag)) {
      log.warn('oauth grant revoked', { grant: grantId, reason });
      return;
    }
  }
  throw new OAuthStorageError(`could not revoke grant ${grantId}: the record kept changing`);
}
