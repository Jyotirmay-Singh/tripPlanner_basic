export type CachedIdentity = {
  id: string;
  email: string;
  name: string;
  role: string;
  is_super_admin?: boolean;
  email_verified?: boolean;
  credentials_set?: boolean;
};

export type CachedIdentityRecord = {
  profile: CachedIdentity;
  verifiedAt: number;
  tokenExpiresAt: number;
};

export type ReadKind = 'expenses' | 'balances' | 'spend' | 'payments';
export type AccountReadKind = 'trip_list' | 'dashboard_overview';
export type Snapshot = { payload: unknown; fetchedAt: number };
export type TripReadBundle = {
  trip: unknown;
  expenses: unknown;
  balances: unknown;
  spend: unknown;
  payments: unknown;
};
export type OutboxState =
  | 'queued' | 'sending' | 'awaiting_reconcile' | 'synced' | 'needs_review' | 'paused_auth';
export type OutboxOperation = 'expense_create' | 'manual_payment_create';
export type StoredOutboxItem = {
  clientMutationId: string;
  accountId: string;
  tripId: string;
  operation: OutboxOperation;
  payload: unknown;
  precondition: unknown;
  queuedAt: number;
  state: OutboxState;
  attemptCount: number;
  nextRetryAt: number | null;
  lastSafeErrorCode: string | null;
  canonicalResourceId: string | null;
  acknowledgedResponse: unknown | null;
  budgetApproved?: boolean;
  reviewContext?: unknown | null;
};
export type OutboxUpdate = Partial<Pick<StoredOutboxItem,
  'state' | 'attemptCount' | 'nextRetryAt' | 'lastSafeErrorCode' | 'canonicalResourceId'
  | 'acknowledgedResponse' | 'budgetApproved' | 'reviewContext'>>;
export type SyncMeta = {
  lastSuccessfulRefreshAt: number | null;
  lastErrorClass: string | null;
};

export interface OfflineStore {
  setActiveAccount(accountId: string | null): void;
  getIdentity(accountId: string): Promise<CachedIdentityRecord | null>;
  saveIdentity(record: CachedIdentityRecord): Promise<void>;
  getExpenseProtocolVersion(accountId: string): Promise<number>;
  setExpenseProtocolVersion(accountId: string, version: number): Promise<void>;
  getTripSnapshot(accountId: string, tripId: string): Promise<Snapshot | null>;
  putTripSnapshot(accountId: string, tripId: string, snapshot: Snapshot): Promise<void>;
  getTripReadBundle(accountId: string, tripId: string): Promise<Snapshot | null>;
  putTripReadBundle(accountId: string, tripId: string, snapshot: Snapshot): Promise<void>;
  removeTripReadData(accountId: string, tripId: string): Promise<void>;
  getAccountReadSnapshot(accountId: string, kind: AccountReadKind): Promise<Snapshot | null>;
  putAccountReadSnapshot(accountId: string, kind: AccountReadKind, snapshot: Snapshot): Promise<void>;
  getReadSnapshot(accountId: string, tripId: string, kind: ReadKind): Promise<Snapshot | null>;
  putReadSnapshot(accountId: string, tripId: string, kind: ReadKind, snapshot: Snapshot): Promise<void>;
  enqueueOutbox(item: StoredOutboxItem): Promise<void>;
  listOutbox(accountId: string): Promise<StoredOutboxItem[]>;
  updateOutbox(accountId: string, mutationId: string, from: OutboxState[], update: OutboxUpdate): Promise<boolean>;
  getSyncMeta(accountId: string, tripId: string): Promise<SyncMeta | null>;
  putSyncMeta(accountId: string, tripId: string, meta: SyncMeta): Promise<void>;
  replaceReviewExpense(accountId: string, oldMutationId: string, item: StoredOutboxItem): Promise<void>;
  discardReviewExpense(accountId: string, mutationId: string): Promise<void>;
  discardReviewPayment(accountId: string, mutationId: string): Promise<void>;
  pendingCount(accountId: string): Promise<number>;
  purgeAccount(accountId: string): Promise<void>;
}

export class OfflineStoreError extends Error {
  constructor(public readonly code: 'unsupported' | 'account_mismatch' | 'key_missing'
    | 'database_missing' | 'encryption_unavailable' | 'migration_failed' | 'unreadable',
  ) {
    super(`Offline storage ${code.replace(/_/g, ' ')}`);
    this.name = 'OfflineStoreError';
  }
}

export function sanitizedIdentity(user: CachedIdentity): CachedIdentity {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    is_super_admin: user.is_super_admin,
    email_verified: user.email_verified,
    credentials_set: user.credentials_set,
  };
}

const forbiddenKeys = new Set([
  'access_token', 'auth_token', 'token', 'password', 'pin', 'pin_hash', 'password_hash',
  'upi_id', 'upi_updated_at', 'transaction_reference', 'receipt_base64', 'receipt_image',
]);

// Future snapshot writers must select the needed API fields. This guard prevents accidental
// persistence of the known secret/payment fields if a whole API object is passed by mistake.
export function safeSnapshotJson(payload: unknown): string {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (forbiddenKeys.has(key.toLowerCase())) {
          throw new Error(`Field ${key} cannot be cached`);
        }
        visit(child);
      }
    }
  };
  visit(payload);
  const json = JSON.stringify(payload);
  if (typeof json !== 'string') throw new Error('Snapshot must be JSON data');
  return json;
}
