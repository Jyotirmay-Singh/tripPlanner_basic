import {
  OfflineStoreError,
  type OfflineStore,
} from './offlineStore.shared';
export { purgeAccountChatOutbox } from './chatOutboxCleanup';

// Web and iOS continue to use the live API. Metro picks offlineStore.android.ts on Android.
export const offlineStore: OfflineStore = {
  setActiveAccount: () => {},
  getIdentity: async () => null,
  saveIdentity: async () => {},
  getTripSnapshot: async () => null,
  putTripSnapshot: async () => { throw new OfflineStoreError('unsupported'); },
  getReadSnapshot: async () => null,
  putReadSnapshot: async () => { throw new OfflineStoreError('unsupported'); },
  enqueueOutbox: async () => { throw new OfflineStoreError('unsupported'); },
  listOutbox: async () => [],
  pendingCount: async () => 0,
  purgeAccount: async () => {},
};
